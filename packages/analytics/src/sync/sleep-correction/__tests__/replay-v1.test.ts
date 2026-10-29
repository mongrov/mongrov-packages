/**
 * v1 ring dumps replayed through the PRODUCTION v2 sleep path, night by night.
 *
 * `parity.test.ts` proves Phase 2 + 3 against the v3.1 oracle, but it stages
 * the capture straight into the v3.1 raw shapes: no mapper, no warehouse DDL,
 * no per-night HR tier, no night replace, no `sessionsFromCorrected`. This
 * suite runs the exact path a ring sync takes — `mapFirmwareExport` →
 * `SensorBuffer` → `BatchFlusher` into real `LOCAL_SCHEMAS` tables →
 * `createSleepDeriver().derive()` → `sleep_session` / `sleep_stage` — and
 * compares what lands in the warehouse with
 *
 *   1. the v3.1 oracle (`fixtures/reference.v31.json`), and
 *   2. each dump's own embedded `sleep_processed` (v3.1 run on the phone).
 *
 * Known convention differences are REPORTED, not hidden, and the assertions
 * are on what must hold regardless: the mapper/flush row counts, a session
 * for every oracle night, and exact-or-explained parity at least as good as
 * the parity harness (89/92). Each drifting night is re-run under controlled
 * conditions so its cause can be named:
 *   (a) tier — D3 per-night tier vs v3.1's whole-history median
 *   (b) scalars — exact `quantile_cont` p75/p90 vs DataFusion's approximation
 *   (c) steps — production stages 1-min `activity.steps`, v3.1 fed the 10-min
 *       `activitydetails.step` (Step 5.6 end refinement)
 *   (d) other
 *
 * Captures are real users' ring data and are not in this repo. Set
 * SLEEP_CAPTURES_DIR to ziva_app `packages/ux/helpers/testFiles` to run.
 * SLEEP_REPLAY_OUT=<file> writes the per-night comparison.
 */
import type { FirmwareExport } from '../../mapper/types'
import type { SqlRunner } from '../correct'
import type { SleepRelations } from '../sql'

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../../__integration__/setup/real-engine'
import { createFakeKV } from '../../../core/__tests__/__fakes__/fake-kv'
import { HybridDuckDB } from '../../../core/engine'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../../core/schemas'
import { SensorBuffer } from '../../buffer'
import { BatchFlusher } from '../../flusher'
import { mapFirmwareExport } from '../../mapper/firmware'
import { OverflowStore } from '../../overflow'
import { createSleepDeriver } from '../../sleep-derive'
import { correctNight, detectNightHrTier, globalBaselines } from '../correct'
import { nightWindow } from '../night'
import { DEFAULT_RELATIONS } from '../sql'

const CAPTURES = process.env.SLEEP_CAPTURES_DIR
const OUT = process.env.SLEEP_REPLAY_OUT
const REF = JSON.parse(readFileSync(join(__dirname, 'fixtures/reference.v31.json'), 'utf8')) as {
  nights: RefNight[]
}

/** The oracle's numeric per-ring offset → the IANA zone production resolves. */
const ZONE_FOR_TZ: Record<string, string> = { '5.5': 'Asia/Kolkata', '-7': 'America/Los_Angeles' }
/** Harness baseline convention: windowStart − 120 d. */
const LOOKBACK_DAYS = 120
/** `parity.test.ts` end-to-end score this path must at least match. */
const PARITY_FLOOR = 89
const TOL_MIN = 2

interface RefNight {
  key: string
  ring: string
  iso: string
  tz: number
  capture?: string
  error?: string
  procStart?: number
  procEnd?: number
  tier?: number
  p75?: number
  p90?: number
  light?: number
  deep?: number
  rem?: number
  nPrimary?: number
  nRows?: number
}

/** One night's primary block, in the oracle's terms. */
interface NightStats {
  procStart: number
  procEnd: number
  light: number
  deep: number
  rem: number
  nPrimary: number
}

interface StoredSession {
  session_id: string
  night: string
  s: number
  e: number
  total_minutes: number
  light_minutes: number
  deep_minutes: number
  rem_minutes: number
  awake_minutes: number
  settle_min: number | null
  recovered_min: number | null
  stages: number
}

interface Delta {
  dStart: number
  dEnd: number
  dLight: number
  dDeep: number
  dRem: number
  dPrimary: number
  exact: boolean
  within: boolean
}

type Cause = 'a' | 'b' | 'c' | 'a+c' | 'b+c' | 'd'

/** A controlled re-run against a target: its deltas, or an outcome (`no_primary`, …). */
type Outcome = Delta | { error: string }

interface Experiments {
  /** Reference scalars (tier/p75/p90), production 1-min steps. */
  refScalars?: Outcome
  /** Production scalars, v3.1's 10-min `activitydetails.step`. */
  steps10?: Outcome
  /** Reference scalars AND 10-min steps. */
  refScalarsSteps10?: Outcome
  cause: Cause
}

/**
 * Why the dump's own `sleep_processed` differs: the phone's v3.1 ran with
 * `cutoff = now − 30 d`, so with no sleeping HR in that window its baselines
 * fell back to p75 = 80 / p90 = 120 (`HR_MAX`), which lets the envelope run
 * to the last firmware minute + 2 h. Re-run with those fallbacks (and v3.1's
 * 10-min steps) and see whether the embedded night is reproduced.
 */
interface EmbeddedExperiments {
  /** Fallback scalars, production (per-night) tier, 10-min steps. */
  fallbackProdTier?: Outcome
  /** Fallback scalars, the oracle's whole-history tier, 10-min steps. */
  fallbackRefTier?: Outcome
  reproduced: boolean
}

interface Compared {
  key: string
  capture: string
  iso: string
  night_of: string
  ref: RefNight
  port: {
    error?: string
    sessions: number
    stats?: NightStats
    tier: number
    tierSource: 'night' | 'recent'
    p75: number
    p90: number
    settle_min?: number | null
    recovered_min?: number
    stageRows?: number
  }
  vsRef?: Delta
  embedded?: NightStats
  vsEmbedded?: Delta
  embeddedVsRef?: Delta
  experiments?: Experiments
  embeddedExperiments?: EmbeddedExperiments
  cutoff: { production: number, harness: number, hrMin: number | null, affectsBaseline: boolean }
}

interface CaptureCounts {
  capture: string
  sleepDump: number
  sleepDistinct: number
  sleepRaw: number
  hrDump: number
  hrDistinct: number
  heartRate: number
  activityDistinct: number
  activity: number
  qualities: Record<string, number>
  embeddedNights: number
}

// ---------------------------------------------------------------------------
// v1 dump → FirmwareExport
// ---------------------------------------------------------------------------

const ROW_SECTIONS = ['heartrate', 'sleep', 'activitydetails', 'spo2', 'temperature_table', 'hrv_table', 'battery_table'] as const

/**
 * A ziva_app dump as the v2 mapper expects it: `date` → `timestamp` in every
 * row, `partition_date` dropped, `null` sections → `[]`, the extra top-level
 * keys (`sleep_processed`, `blood_glucose_table`, `codePushBundleId`) left
 * behind, and the RxDB `ring` docs replaced by an empty monitoring config
 * (their vendor shape is not the JStyle struct `mapRingConfig` reads).
 */
export function convertV1(dump: Record<string, unknown>): FirmwareExport {
  const out: Record<string, unknown> = {}
  for (const section of ROW_SECTIONS) {
    const rows = Array.isArray(dump[section]) ? dump[section] as Record<string, unknown>[] : []
    out[section] = rows.map(({ date, partition_date: _p, ...rest }) => ({ ...rest, timestamp: date }))
  }
  out.ring = { automaticMonitoringData: [] }
  return out as unknown as FirmwareExport
}

/** Harness `epoch()`: "YYYY.MM.DD HH:MM:SS" parsed as UTC. */
function epoch(v: unknown): number | null {
  if (v == null)
    return null
  if (typeof v === 'number')
    return Math.floor(v > 1e12 ? v / 1000 : v)
  if (typeof v === 'bigint')
    return Number(v)
  const m = String(v).match(/(\d{4})\.(\d{2})\.(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) {
    const n = Number(v)
    return Number.isFinite(n) ? Math.floor(n) : null
  }
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000)
}

const num = (v: unknown) => (v == null ? null : Number(v))

/** v3.1 morning-named night → the EVENING date `night_of` is stored as. */
function eveningOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

/** The v3.1 harness's `nightOf`: local time + 6 h, take the date. */
function nightOfEpoch(e: number, tzHours: number): string {
  return new Date((e + tzHours * 3600 + 6 * 3600) * 1000).toISOString().slice(0, 10)
}

/** Stats from classified rows (firmware codes 1 deep / 2 light / 3 rem). */
function statsFromRows(rows: ReadonlyArray<{ date: string, quality: number }>): NightStats | null {
  if (!rows.length)
    return null
  const eps = rows.map(r => epoch(r.date)!).sort((a, b) => a - b)
  let light = 0
  let deep = 0
  let rem = 0
  for (const r of rows) {
    if (r.quality === 1)
      deep++
    else if (r.quality === 2)
      light++
    else if (r.quality === 3)
      rem++
  }
  return { procStart: eps[0], procEnd: eps[eps.length - 1], light, deep, rem, nPrimary: rows.length }
}

/** Stored sessions of one night → the oracle's terms (union when split). */
function statsFromSessions(sessions: readonly StoredSession[]): NightStats | null {
  if (!sessions.length)
    return null
  return {
    procStart: Math.min(...sessions.map(s => s.s)),
    // `ts_end` is the last minute + 60 s; the oracle's `procEnd` is the last minute.
    procEnd: Math.max(...sessions.map(s => s.e)) - 60,
    // Session columns are already named by stage; the DDL codes (2 light /
    // 3 deep / 5 rem) never surface here.
    light: sessions.reduce((n, s) => n + s.light_minutes, 0),
    deep: sessions.reduce((n, s) => n + s.deep_minutes, 0),
    rem: sessions.reduce((n, s) => n + s.rem_minutes, 0),
    nPrimary: sessions.reduce((n, s) => n + s.total_minutes, 0),
  }
}

function delta(a: NightStats, b: NightStats): Delta {
  const d = {
    dStart: (a.procStart - b.procStart) / 60,
    dEnd: (a.procEnd - b.procEnd) / 60,
    dLight: a.light - b.light,
    dDeep: a.deep - b.deep,
    dRem: a.rem - b.rem,
    dPrimary: a.nPrimary - b.nPrimary,
  }
  const stages = [d.dLight, d.dDeep, d.dRem]
  return {
    ...d,
    exact: d.dStart === 0 && d.dEnd === 0 && stages.every(x => x === 0) && d.dPrimary === 0,
    within: Math.abs(d.dStart) <= TOL_MIN && Math.abs(d.dEnd) <= TOL_MIN && stages.every(x => Math.abs(x) <= TOL_MIN),
  }
}

function refStats(ref: RefNight): NightStats | null {
  if (ref.error || ref.procStart == null)
    return null
  return { procStart: ref.procStart, procEnd: ref.procEnd!, light: ref.light ?? 0, deep: ref.deep ?? 0, rem: ref.rem ?? 0, nPrimary: ref.nPrimary ?? 0 }
}

/** The dump's own `sleep_processed`, primary rows grouped by v3.1 night. */
function embeddedNights(dump: Record<string, unknown>, tzHours: number): Map<string, NightStats> {
  const rows = Array.isArray(dump.sleep_processed) ? dump.sleep_processed as Array<Record<string, unknown>> : []
  const byNight = new Map<string, Array<{ date: string, quality: number }>>()
  for (const r of rows) {
    if (r.block_type !== 'primary')
      continue
    const e = epoch(r.date)
    if (e == null)
      continue
    const night = nightOfEpoch(e, tzHours)
    byNight.set(night, [...(byNight.get(night) ?? []), { date: String(r.date), quality: Number(r.quality) }])
  }
  const out = new Map<string, NightStats>()
  for (const [night, rs] of byNight) out.set(night, statsFromRows(rs)!)
  return out
}

// ---------------------------------------------------------------------------
// The production rig — `sleep-derive.test.ts` `rig()` fed by the mapper
// ---------------------------------------------------------------------------

const TABLES = ['sleep_raw', 'sleep_session', 'sleep_stage', 'heart_rate', 'activity', 'activity_bucket'] as const
const FLUSHED = ['heart_rate', 'activity', 'activity_bucket', 'sleep_raw'] as const

const lit = (v: unknown) => (v == null || v === '' || Number.isNaN(Number(v)) ? 'NULL' : String(Number(v)))

async function insertChunks(db: SqlRunner, table: string, rows: unknown[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) {
    const values = rows.slice(i, i + 1000).map(r => `(${r.map(lit).join(', ')})`).join(',\n')
    if (values)
      await db.execute(`INSERT INTO ${table} VALUES ${values}`)
  }
}

interface Replay {
  db: HybridDuckDB
  cutoffEpoch: number
  hrMin: number | null
  sessions: StoredSession[]
  counts: Omit<CaptureCounts, 'capture' | 'embeddedNights'>
}

async function replayCapture(dump: Record<string, unknown>, deviceId: string, timeZone: string): Promise<Replay> {
  const tenant = { brand: 'ziva', familyId: 'fam', userId: 'u', deviceId }
  const ctx = { ...tenant, userTimezone: timeZone }

  const db = new HybridDuckDB(() => createRealDuckDB([]))
  await db.open()
  for (const t of TABLES) await db.execute(LOCAL_SCHEMAS[t])
  for (const t of ['heart_rate', 'activity'] as const)
    await db.execute(generateViewDdl(t, { brand: tenant.brand, familyId: tenant.familyId, localCatalog: 'memory' }))
  const columnOrder: Record<string, string[]> = {}
  for (const t of TABLES) {
    const cols = await db.execute<{ column_name: string }>(
      `SELECT column_name FROM duckdb_columns() WHERE table_name = '${t}' ORDER BY column_index`,
    )
    columnOrder[t] = cols.map(c => c.column_name)
  }

  const batch = mapFirmwareExport(convertV1(dump), ctx)
  const lastRawMs = Math.max(...batch.sleep_raw.map(r => r.ts.getTime()))
  const now = lastRawMs + 60_000
  const cutoffEpoch = Math.floor(now / 1000) - LOOKBACK_DAYS * 86400

  const buffer = new SensorBuffer({ overflow: new OverflowStore(createFakeKV().kv) })
  const flusher = new BatchFlusher({ engine: db, buffer, columnOrder })
  const deriver = createSleepDeriver({
    engine: db,
    buffer,
    flusher,
    resolveTimezone: async () => timeZone,
    now: () => now,
    lookbackDays: LOOKBACK_DAYS,
  })

  for (const t of FLUSHED) {
    if (batch[t].length)
      await buffer.push({ table: t, ...tenant, rows: batch[t] as unknown as Record<string, unknown>[] })
  }
  deriver.noteRaw({ ...tenant, rows: batch.sleep_raw as unknown as Record<string, unknown>[] })
  const batchId = flusher.beginBatch('manual')
  for (const t of FLUSHED) await flusher.flush(t, 'manual', batchId)
  await deriver.derive(batchId, 'manual')
  flusher.endBatch(batchId)

  const count = async (table: string) => Number((await db.execute<{ n: unknown }>(`SELECT count(*) AS n FROM ${table}`))[0].n)
  const qualities: Record<string, number> = {}
  for (const q of await db.execute<{ quality: unknown, n: unknown }>(`SELECT quality, count(*) AS n FROM sleep_raw GROUP BY quality ORDER BY quality`))
    qualities[String(q.quality)] = Number(q.n)
  const [hr] = await db.execute<{ e: unknown }>(`SELECT CAST(epoch(min(ts)) AS BIGINT) AS e FROM heart_rate`)

  const rec = (x: unknown) => x as Record<string, unknown>
  const sleepDump = (Array.isArray(dump.sleep) ? dump.sleep : []).map(rec)
  const hrDump = (Array.isArray(dump.heartrate) ? dump.heartrate : []).map(rec)
  const actDump = (Array.isArray(dump.activitydetails) ? dump.activitydetails : []).map(rec)
  const activityMinutes = new Set<number>()
  for (const r of actDump) {
    const base = epoch(r.date)!
    const n = Array.isArray(r.arraySteps) ? r.arraySteps.length : 0
    for (let i = 0; i < n; i++) activityMinutes.add(base + i * 60)
  }

  const sessions = (await db.execute<Record<string, unknown>>(
    `SELECT s.session_id, CAST(s.night_of AS VARCHAR) AS night,
            CAST(epoch(s.ts_start) AS BIGINT) AS s, CAST(epoch(s.ts_end) AS BIGINT) AS e,
            s.total_minutes, s.light_minutes, s.deep_minutes, s.rem_minutes, s.awake_minutes,
            s.settle_min, s.recovered_min,
            (SELECT count(*) FROM sleep_stage g WHERE g.session_id = s.session_id) AS stages
     FROM sleep_session s ORDER BY s.ts_start`,
  )).map(r => ({
    session_id: String(r.session_id),
    night: String(r.night),
    s: Number(r.s),
    e: Number(r.e),
    total_minutes: Number(r.total_minutes),
    light_minutes: Number(r.light_minutes ?? 0),
    deep_minutes: Number(r.deep_minutes ?? 0),
    rem_minutes: Number(r.rem_minutes ?? 0),
    awake_minutes: Number(r.awake_minutes ?? 0),
    settle_min: num(r.settle_min),
    recovered_min: num(r.recovered_min),
    stages: Number(r.stages),
  }))

  return {
    db,
    cutoffEpoch,
    hrMin: num(hr?.e),
    sessions,
    counts: {
      sleepDump: sleepDump.length,
      sleepDistinct: new Set(sleepDump.map(r => `${epoch(r.start)}|${epoch(r.date)}`)).size,
      sleepRaw: await count('sleep_raw'),
      hrDump: hrDump.length,
      hrDistinct: new Set(hrDump.map(r => epoch(r.date))).size,
      heartRate: await count('heart_rate'),
      activityDistinct: activityMinutes.size,
      activity: await count('activity'),
      qualities,
    },
  }
}

/**
 * One night through `correctNight` alone, over the staging views the deriver
 * left behind (`stg_*`), with chosen scalars and step relation — the
 * controlled re-runs that name a drifting night's cause.
 */
async function rerunNight(
  db: SqlRunner,
  ref: RefNight,
  timeZone: string,
  scalars: { tier: number, p75: number, p90: number },
  relations: SleepRelations,
): Promise<NightStats | { error: string }> {
  const w = nightWindow(ref.iso, timeZone)
  const res = await correctNight(db, { ...w, hrIntervalMin: scalars.tier, p75: scalars.p75, p90: scalars.p90, relations })
  if (res.status !== 'ok')
    return { error: res.status }
  const stats = statsFromRows(res.rows.filter(r => r.block_type === 'primary'))
  return stats ?? { error: 'no_primary' }
}

/**
 * A re-run against its target: deltas when both have a primary block; the
 * re-run's outcome otherwise. `error: 'match:<status>'` marks a re-run that
 * reproduced the target's own non-result (the oracle's `no_primary`).
 */
function toOutcome(target: NightStats | null, targetError: string | undefined, got: NightStats | { error: string }): Outcome {
  if ('error' in got)
    return { error: targetError && got.error === targetError ? `match:${got.error}` : got.error }
  return target ? delta(got, target) : { error: `primary where target had ${targetError ?? 'none'}` }
}

const reproduces = (d: Outcome | undefined) => d != null && ('error' in d ? d.error.startsWith('match:') : d.within)

function causeOf(tierChanged: boolean, x: Omit<Experiments, 'cause'>): Cause {
  if (reproduces(x.refScalars))
    return tierChanged ? 'a' : 'b'
  if (reproduces(x.steps10))
    return 'c'
  if (reproduces(x.refScalarsSteps10))
    return tierChanged ? 'a+c' : 'b+c'
  return 'd'
}

function fmt(d: Outcome | undefined): string {
  if (d == null)
    return '-'
  if ('error' in d)
    return d.error
  return `start ${d.dStart} end ${d.dEnd} L${d.dLight} D${d.dDeep} R${d.dRem} n${d.dPrimary}${d.exact ? ' exact' : d.within ? ' within' : ''}`
}

// ---------------------------------------------------------------------------

describe.skipIf(!CAPTURES)('sleep correction — v1 dumps through the production path vs v3.1', () => {
  it('lands the oracle nights in sleep_session / sleep_stage', async () => {
    const byCapture = new Map<string, RefNight[]>()
    for (const n of REF.nights) {
      if (!n.capture)
        continue
      byCapture.set(n.capture, [...(byCapture.get(n.capture) ?? []), n])
    }

    const results: Compared[] = []
    const counts: CaptureCounts[] = []
    const surprises: string[] = []

    for (const [file, nights] of byCapture) {
      const dump = JSON.parse(readFileSync(join(CAPTURES!, file), 'utf8')) as Record<string, unknown>
      const timeZone = ZONE_FOR_TZ[String(nights[0].tz)]
      if (!timeZone)
        throw new Error(`no IANA zone for tz ${nights[0].tz}`)

      const r = await replayCapture(dump, nights[0].ring, timeZone)
      const embedded = embeddedNights(dump, nights[0].tz)
      counts.push({ capture: file, ...r.counts, embeddedNights: embedded.size })

      // The deriver's staging views outlive `derive()`; the scalars it used
      // are re-read from them (it does not expose per-night tiers).
      const db = r.db as unknown as SqlRunner
      const { p75, p90 } = await globalBaselines(db, r.cutoffEpoch)
      let steps10Ready = false

      for (const ref of nights) {
        const w = nightWindow(ref.iso, timeZone)
        if (w.tzOffsetHours !== ref.tz)
          surprises.push(`${ref.key}: IANA offset ${w.tzOffsetHours} != oracle tz ${ref.tz}`)
        const tier = await detectNightHrTier(db, w.windowStart, w.windowEnd)
        const nightOf = eveningOf(ref.iso)
        const mine = r.sessions.filter(s => s.night === nightOf)
        const stats = statsFromSessions(mine)
        const want = refStats(ref)
        const emb = embedded.get(ref.iso)
        const harnessCutoff = w.windowStart - LOOKBACK_DAYS * 86400

        const row: Compared = {
          key: ref.key,
          capture: file,
          iso: ref.iso,
          night_of: nightOf,
          ref,
          port: {
            error: stats ? undefined : 'no_session',
            sessions: mine.length,
            stats: stats ?? undefined,
            tier: tier.tier,
            tierSource: tier.source,
            p75,
            p90,
            settle_min: mine[0]?.settle_min,
            recovered_min: mine.reduce((n, s) => n + (s.recovered_min ?? 0), 0),
            stageRows: mine.reduce((n, s) => n + s.stages, 0),
          },
          vsRef: stats && want ? delta(stats, want) : undefined,
          embedded: emb,
          vsEmbedded: stats && emb ? delta(stats, emb) : undefined,
          embeddedVsRef: emb && want ? delta(emb, want) : undefined,
          cutoff: {
            production: r.cutoffEpoch,
            harness: harnessCutoff,
            hrMin: r.hrMin,
            // The two cutoffs only matter if HR history reaches back past the later one.
            affectsBaseline: r.hrMin != null && r.hrMin < Math.max(r.cutoffEpoch, harnessCutoff),
          },
        }

        for (const s of mine) {
          if (s.stages !== s.total_minutes)
            surprises.push(`${ref.key}: session ${s.session_id} has ${s.stages} stage rows for ${s.total_minutes} minutes`)
        }
        if (mine.length > 1)
          surprises.push(`${ref.key}: ${mine.length} sessions (split primary block) — compared as a union`)
        if (!stats && !ref.error) {
          const near = r.sessions.map(s => `${s.night}:${s.total_minutes}m`).join(', ')
          surprises.push(`${ref.key}: no session stored for night_of ${nightOf}; stored nights: ${near || 'none'}`)
        }

        const steps10: SleepRelations = { ...DEFAULT_RELATIONS, activity: 'stg_activity_10' }
        const ensureSteps10 = async () => {
          if (steps10Ready)
            return
          await db.execute(`CREATE TEMP TABLE stg_activity_10 (date BIGINT, step DOUBLE)`)
          const act = (Array.isArray(dump.activitydetails) ? dump.activitydetails : []) as Array<Record<string, unknown>>
          await insertChunks(db, 'stg_activity_10', act.map(a => [epoch(a.date), a.step]))
          steps10Ready = true
        }

        // Drift from the oracle (or a session where the oracle had none):
        // re-run under controlled conditions to name the cause.
        const driftsFromRef = want ? row.vsRef != null && !row.vsRef.within : ref.error != null && stats != null
        if (driftsFromRef && ref.tier != null && ref.p75 != null && ref.p90 != null) {
          await ensureSteps10()
          const refScalars = { tier: ref.tier, p75: ref.p75, p90: ref.p90 }
          const prodScalars = { tier: tier.tier, p75, p90 }
          const x = {
            refScalars: toOutcome(want, ref.error, await rerunNight(db, ref, timeZone, refScalars, DEFAULT_RELATIONS)),
            steps10: toOutcome(want, ref.error, await rerunNight(db, ref, timeZone, prodScalars, steps10)),
            refScalarsSteps10: toOutcome(want, ref.error, await rerunNight(db, ref, timeZone, refScalars, steps10)),
          }
          row.experiments = { ...x, cause: causeOf(tier.tier !== ref.tier, x) }
        }

        // Drift from the phone's own output: the empty-baseline fallback hypothesis.
        if (emb && row.vsEmbedded && !row.vsEmbedded.within) {
          await ensureSteps10()
          const fallback = { p75: 80, p90: 120 }
          const x = {
            fallbackProdTier: toOutcome(emb, undefined, await rerunNight(db, ref, timeZone, { tier: tier.tier, ...fallback }, steps10)),
            fallbackRefTier: ref.tier != null
              ? toOutcome(emb, undefined, await rerunNight(db, ref, timeZone, { tier: ref.tier, ...fallback }, steps10))
              : undefined,
          }
          row.embeddedExperiments = { ...x, reproduced: reproduces(x.fallbackProdTier) || reproduces(x.fallbackRefTier) }
        }
        results.push(row)
      }
      await r.db.close()
    }

    if (OUT)
      writeFileSync(OUT, JSON.stringify({ results, counts, surprises }, null, 1))

    // ---- summaries, parity.test.ts style ----
    const scored = results.filter(r => r.vsRef)
    const exact = scored.filter(r => r.vsRef!.exact)
    const within = scored.filter(r => r.vsRef!.within && !r.vsRef!.exact)
    const drift = scored.filter(r => !r.vsRef!.within)
    const explained = drift.filter(r => r.experiments?.cause !== 'd')
    const refTotal = REF.nights.filter(n => n.capture).length
    console.log(`replay vs v3.1 oracle: ${exact.length}/${refTotal} exact, ${within.length} within ±${TOL_MIN} min start/end & ±${TOL_MIN} min stages, `
      + `${drift.length} drift (${explained.length} explained), ${results.filter(r => r.port.error).length} no session`)
    const driftLine = (r: Compared, d: Outcome) =>
      `  drift ${r.key}: ${fmt(d)} | tier ${r.ref.tier}->${r.port.tier}/${r.port.tierSource} `
      + `p75 ${r.ref.p75}->${r.port.p75} p90 ${r.ref.p90}->${r.port.p90} | cause (${r.experiments?.cause ?? '?'}) `
      + `[ref scalars: ${fmt(r.experiments?.refScalars)}; 10-min steps: ${fmt(r.experiments?.steps10)}; both: ${fmt(r.experiments?.refScalarsSteps10)}]`
    for (const r of drift) console.log(driftLine(r, r.vsRef!))
    // Oracle nights with no primary block that the production path did correct.
    const unexpected = results.filter(r => r.ref.error && r.port.stats)
    for (const r of unexpected)
      console.log(driftLine(r, { error: `${r.port.stats!.nPrimary} min session where oracle said ${r.ref.error}` }))

    const withEmb = results.filter(r => r.vsEmbedded)
    const embExact = withEmb.filter(r => r.vsEmbedded!.exact)
    const embWithin = withEmb.filter(r => r.vsEmbedded!.within && !r.vsEmbedded!.exact)
    const embDrift = withEmb.filter(r => !r.vsEmbedded!.within)
    console.log(`replay vs embedded sleep_processed: ${embExact.length}/${withEmb.length} exact, ${embWithin.length} within, ${embDrift.length} drift `
      + `(${results.length - withEmb.length} reference nights without an embedded night)`)
    for (const r of embDrift) {
      console.log(`  drift ${r.key}: ${fmt(r.vsEmbedded)} | embedded vs oracle: ${fmt(r.embeddedVsRef)} | `
        + `fallback p75=80/p90=120 + 10-min steps reproduces embedded: ${r.embeddedExperiments?.reproduced ? 'yes' : 'no'} `
        + `[prod tier: ${fmt(r.embeddedExperiments?.fallbackProdTier)}; oracle tier: ${fmt(r.embeddedExperiments?.fallbackRefTier)}]`)
    }
    console.log(`embedded drift reproduced by the empty-baseline fallback: ${embDrift.filter(r => r.embeddedExperiments?.reproduced).length}/${embDrift.length}`)
    const embRef = results.filter(r => r.embeddedVsRef)
    console.log(`embedded sleep_processed vs v3.1 oracle: ${embRef.filter(r => r.embeddedVsRef!.exact).length}/${embRef.length} exact, `
      + `${embRef.filter(r => r.embeddedVsRef!.within && !r.embeddedVsRef!.exact).length} within, ${embRef.filter(r => !r.embeddedVsRef!.within).length} drift`)

    const tierChanged = results.filter(r => r.ref.tier != null && r.port.tier !== r.ref.tier)
    console.log(`tier: ${tierChanged.length} nights differ from the oracle (D3 per-night); sources: `
      + `${results.filter(r => r.port.tierSource === 'night').length} night / ${results.filter(r => r.port.tierSource === 'recent').length} recent`)
    console.log(`baseline cutoff: ${results.filter(r => r.cutoff.affectsBaseline).length} nights where HR history reaches past the cutoff (production vs harness convention could differ)`)
    for (const s of surprises) console.log(`  note ${s}`)

    // ---- assertions ----
    // Mapper + flush: every dump row reached its table, PK dedupe aside.
    for (const c of counts) {
      expect({ capture: c.capture, sleepRaw: c.sleepRaw, heartRate: c.heartRate, activity: c.activity })
        .toEqual({ capture: c.capture, sleepRaw: c.sleepDistinct, heartRate: c.hrDistinct, activity: c.activityDistinct })
    }
    // Every oracle night the pipeline corrected has a stored session.
    expect(results.filter(r => !r.ref.error && r.ref.procStart != null && r.port.error).map(r => r.key)).toEqual([])
    // Stages are written one per session minute.
    expect(surprises.filter(s => s.includes('stage rows for'))).toEqual([])
    // At least as good as the parity harness, once the known conventions are named.
    expect(exact.length + within.length + explained.length).toBeGreaterThanOrEqual(PARITY_FLOOR)
  }, 600_000)
})
