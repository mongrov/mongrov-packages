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
 *   (c) steps — production re-aggregates the 1-min `activity.steps` into the
 *       10-min `activity_bucket` (staging.ts, 0.48.0); v3.1 fed the record's
 *       own `activitydetails.step`. The two differ where sum(arraySteps) ≠
 *       step (~1.3% of records) or a bucket has no minute rows.
 *   (d) other
 *
 * Captures are real users' ring data and are not in this repo. Set
 * SLEEP_CAPTURES_DIR to ziva_app `packages/ux/helpers/testFiles` to run.
 * SLEEP_REPLAY_OUT=<file> writes the per-night comparison.
 *
 * ## Display parity (report only)
 *
 * The two apps put different numbers on the sleep screen from the SAME rows:
 * v1's Day tab (`ziva_app sqlquery.ts` `sleepSummaryQuery`) shows `total` =
 * every primary minute, awake included, over `[D-1 18:00, D 17:59:59]` local;
 * v2's Night range (`zivaone_app derive-night.ts` `durationMin`) shows
 * light + deep + rem only, bed/wake from the stage rows. After every night is
 * derived, the stored `sleep_session` / `sleep_stage` rows are read both ways
 * — the app's own `sleep.night` SQL (copied below, params bound) folded by
 * `deriveNight`'s rules, and v1's window summary — and set beside the oracle.
 * The delta between the two headline numbers is exactly the night's awake
 * minutes, which is the size of the open decision; the distribution is
 * printed. SLEEP_DISPLAY_OUT=<file> writes the per-night numbers.
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
const DISPLAY_OUT = process.env.SLEEP_DISPLAY_OUT
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
  /** Reference scalars (tier/p75/p90), production step relation. */
  refScalars?: Outcome
  /** Production scalars, v1's exact input: the record's `activitydetails.step`. */
  v1Steps?: Outcome
  /** Reference scalars AND v1 step totals. */
  refScalarsV1Steps?: Outcome
  cause: Cause
}

/**
 * Why the dump's own `sleep_processed` differs: the phone's v3.1 ran with
 * `cutoff = now − 30 d`, so with no sleeping HR in that window its baselines
 * fell back to p75 = 80 / p90 = 120 (`HR_MAX`), which lets the envelope run
 * to the last firmware minute + 2 h. Re-run with those fallbacks (and v1's
 * step totals) and see whether the embedded night is reproduced.
 */
interface EmbeddedExperiments {
  /** Fallback scalars, production (per-night) tier, v1 step totals. */
  fallbackProdTier?: Outcome
  /** Fallback scalars, the oracle's whole-history tier, v1 step totals. */
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

/** What one app's sleep screen would show for the night, from the stored rows. */
interface Shown {
  /** v1: every primary minute; v2: light + deep + rem. */
  headlineMin: number
  light: number
  deep: number
  rem: number
  awake: number
  /** v1 `start` / v2 bed, local wall clock `YYYY-MM-DD HH:MM:SS`. */
  startLocal: string
  /** v1 `end` (last minute) / v2 wake (last minute + block), local. */
  endLocal: string
}

interface Displayed {
  key: string
  iso: string
  night_of: string
  /** `$offset` bound into `sleep.night`; > 365 is outside the app's input schema. */
  offset: number
  /** `sleep.night` row count (one per stage row, LEFT JOIN). */
  rows: number
  v2?: Shown & { awakenings: number, sessionCount: number, spacing: number }
  v1?: Shown & { total: number, asleep: number, efficiency: number, sessions: number }
  oracle?: Shown & { total: number, asleep: number }
  /** v1 total − v2 headline; equals v1 awake when both read the same rows. */
  totalMinusDuration?: number
  /** v2 bed − v1 start, v2 wake − v1 end, minutes. Wake is +1 by construction (end is the last minute). */
  dBedMin?: number
  dWakeMin?: number
  /** Rows the v1 window saw that are not the night's sessions, or vice versa. */
  rowMismatch?: string
  /** Every stored session with a minute inside the v1 window, and how much of it the window holds. */
  windowSessions?: Array<{ session_id: string, night_of: string, inWindow: number, total: number, startLocal: string, endLocal: string }>
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
// The two screens, from the stored rows
// ---------------------------------------------------------------------------

/**
 * zivaone_app `src/features/sleep/queries.ts` — `sleepNight.sql`, copied
 * verbatim with its four helpers (`tenant`, `local`, `TARGET_NIGHT_SQL`,
 * `STAGE_CASE_SQL` from `utils/stages.ts`) expanded exactly as the app
 * emits them. Binds `$userId` / `$brand` / `$familyId` / `$tz` / `$offset`.
 * Kept as a fixture rather than imported: this package cannot depend on the
 * app, and a copy that drifts from the app is the point of re-checking it.
 */
const APP_TENANT = (alias: string) => `${alias}.user_id = $userId AND ${alias}.brand = $brand AND ${alias}.family_id = $familyId`
const APP_LOCAL = (expr: string) => `timezone(CAST($tz AS VARCHAR), timezone('UTC', ${expr}))`
const APP_TARGET_NIGHT_SQL = `
      date_trunc('day', timezone(CAST($tz AS VARCHAR), now()))
        - (INTERVAL 1 DAY) * (CAST($offset AS BIGINT) + 1)`
const APP_STAGE_CASE_SQL = `CASE g.stage
      WHEN 1 THEN 'awake'
      WHEN 2 THEN 'light'
      WHEN 3 THEN 'deep'
      WHEN 5 THEN 'rem'
      ELSE 'awake'
    END`
const APP_SLEEP_NIGHT_SQL = `
    WITH params AS (
      SELECT CAST(${APP_TARGET_NIGHT_SQL} AS DATE) AS night_of
    ),
    sessions AS (
      SELECT s.*
      FROM v_sleep_session s CROSS JOIN params p
      WHERE ${APP_TENANT('s')}
        AND s.night_of = p.night_of
    )
    SELECT
      CAST(s.night_of AS VARCHAR) AS night_of,
      s.session_id,
      CAST(${APP_LOCAL('s.ts_start')} AS VARCHAR) AS session_start_local,
      CAST(${APP_LOCAL('s.ts_end')} AS VARCHAR) AS session_end_local,
      s.total_minutes,
      s.deep_minutes,
      s.rem_minutes,
      s.light_minutes,
      s.awake_minutes,
      CAST(${APP_LOCAL('g.ts')} AS VARCHAR) AS stage_ts_local,
      ${APP_STAGE_CASE_SQL} AS stage_name
    FROM sessions s
    LEFT JOIN v_sleep_stage g
      ON g.session_id = s.session_id
     AND ${APP_TENANT('g')}
    ORDER BY s.ts_start, g.ts
  `

type AppStage = 'awake' | 'light' | 'deep' | 'rem'

interface AppNightRow {
  night_of: string
  session_id: string
  session_start_local: string
  session_end_local: string
  stage_ts_local: string | null
  stage_name: AppStage | null
}

/** `derive-night.ts` `minutesFromAnchor`: wall-clock fields, no zone. */
function minutesFromAnchor(local: string, anchorDay: string): number {
  const [datePart = '', timePart = '00:00:00'] = local.split(/[ T]/)
  const [y = 0, mo = 1, d = 1] = datePart.split('-').map(Number)
  const [hh = 0, mi = 0, ss = 0] = timePart.split(':').map(Number)
  const [ay = 0, amo = 1, ad = 1] = anchorDay.slice(0, 10).split('-').map(Number)
  return Math.round((Date.UTC(y, mo - 1, d, hh, mi, ss) - Date.UTC(ay, amo - 1, ad)) / 60_000)
}

/** Minutes past the anchor midnight → local wall clock, the inverse of the above. */
function wallClock(anchorDay: string, min: number): string {
  const [ay = 0, amo = 1, ad = 1] = anchorDay.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(ay, amo - 1, ad) + min * 60_000).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * `derive-night.ts` `deriveNight`, the lines that produce the screen's
 * numbers: samples → spacing → segments → bed/wake/duration/awakenings.
 * Re-implemented here (the app is not a dependency of this package) and kept
 * line-for-line with the app so a difference below is a display-path finding.
 */
function deriveNightLikeApp(rows: AppNightRow[]): Displayed['v2'] | undefined {
  if (rows.length === 0)
    return undefined
  const anchorDay = rows[0].night_of
  const samples = rows
    .filter(r => r.stage_ts_local != null && r.stage_name != null)
    .map(r => ({ min: minutesFromAnchor(r.stage_ts_local!, anchorDay), stage: r.stage_name! }))
    .sort((a, b) => a.min - b.min)
  const spacing = samples.length > 1
    ? Math.max(1, Math.min(...samples.slice(1).map((s, i) => s.min - samples[i].min)))
    : 1
  const segments: Array<{ stage: AppStage, startMin: number, lengthMin: number }> = []
  for (const sample of samples) {
    const open = segments.at(-1)
    if (open && open.stage === sample.stage && open.startMin + open.lengthMin === sample.min)
      open.lengthMin += spacing
    else
      segments.push({ stage: sample.stage, startMin: sample.min, lengthMin: spacing })
  }
  const first = segments[0]
  const last = segments.at(-1)
  const bedMin = first ? first.startMin : minutesFromAnchor(rows[0].session_start_local, anchorDay)
  const wakeMin = last ? last.startMin + last.lengthMin : minutesFromAnchor(rows.at(-1)!.session_end_local, anchorDay)
  const lane = (s: AppStage) => segments.filter(x => x.stage === s).reduce((a, x) => a + x.lengthMin, 0)
  const lastAsleep = segments.findLastIndex(s => s.stage !== 'awake')
  return {
    headlineMin: lane('light') + lane('deep') + lane('rem'),
    light: lane('light'),
    deep: lane('deep'),
    rem: lane('rem'),
    awake: lane('awake'),
    startLocal: wallClock(anchorDay, bedMin),
    endLocal: wallClock(anchorDay, wakeMin),
    awakenings: lastAsleep < 0 ? 0 : segments.slice(0, lastAsleep).filter(s => s.stage === 'awake').length,
    sessionCount: new Set(rows.map(r => r.session_id)).size,
    spacing,
  }
}

/**
 * v1's `sleepSummaryQuery` over the stored stage rows: every minute in
 * `[D-1 18:00, D 17:59:59]` local (`nightWindow`'s `[windowStart, windowEnd)`),
 * whichever session it belongs to, with the warehouse stage codes (2 light /
 * 3 deep / 5 rem; anything else is v1's `quality NOT IN (1,2,3)` = awake).
 */
async function v1Summary(db: HybridDuckDB, w: { windowStart: number, windowEnd: number }, timeZone: string): Promise<Displayed['v1'] | undefined> {
  const [r] = await db.execute<Record<string, unknown>>(
    `SELECT count(*) AS total,
            CAST(timezone('${timeZone}', timezone('UTC', min(ts))) AS VARCHAR) AS start_local,
            CAST(timezone('${timeZone}', timezone('UTC', max(ts))) AS VARCHAR) AS end_local,
            sum(CASE WHEN stage = 3 THEN 1 ELSE 0 END) AS deep,
            sum(CASE WHEN stage = 2 THEN 1 ELSE 0 END) AS light,
            sum(CASE WHEN stage = 5 THEN 1 ELSE 0 END) AS rem,
            sum(CASE WHEN stage NOT IN (2, 3, 5) THEN 1 ELSE 0 END) AS awake,
            count(DISTINCT session_id) AS sessions
     FROM sleep_stage
     WHERE epoch(ts) >= ${w.windowStart} AND epoch(ts) < ${w.windowEnd}`,
  )
  const total = Number(r.total)
  if (!total)
    return undefined
  const awake = Number(r.awake)
  return {
    headlineMin: total,
    total,
    asleep: total - awake,
    efficiency: (total - awake) / total,
    light: Number(r.light),
    deep: Number(r.deep),
    rem: Number(r.rem),
    awake,
    startLocal: String(r.start_local),
    endLocal: String(r.end_local),
    sessions: Number(r.sessions),
  }
}

/** The oracle's night in the same terms (`awake` = nPrimary − stages). */
function oracleShown(ref: RefNight, tzHours: number): Displayed['oracle'] | undefined {
  const s = refStats(ref)
  if (!s)
    return undefined
  const awake = s.nPrimary - s.light - s.deep - s.rem
  const local = (e: number) => new Date((e + tzHours * 3600) * 1000).toISOString().slice(0, 19).replace('T', ' ')
  return { headlineMin: s.nPrimary, total: s.nPrimary, asleep: s.nPrimary - awake, light: s.light, deep: s.deep, rem: s.rem, awake, startLocal: local(s.procStart), endLocal: local(s.procEnd) }
}

const wallMinutes = (local: string) => minutesFromAnchor(local, '1970-01-01')

/** Local today in `timeZone`, as `sleep.night`'s `params` CTE computes it. */
async function localToday(db: HybridDuckDB, timeZone: string): Promise<string> {
  const [r] = await db.execute<{ d: unknown }>(
    `SELECT CAST(CAST(date_trunc('day', timezone(CAST($tz AS VARCHAR), now())) AS DATE) AS VARCHAR) AS d`,
    { tz: timeZone },
  )
  return String(r.d)
}

/**
 * One night read the way each screen reads it. `sleep.night` anchors on
 * `now()`, so the night is reached through `$offset` = nights back from
 * local today − 1, exactly as the Night range chevron would.
 */
async function displayNight(
  db: HybridDuckDB,
  ref: RefNight,
  w: { windowStart: number, windowEnd: number, tzOffsetHours: number },
  timeZone: string,
  nightOf: string,
  today: string,
): Promise<Displayed> {
  const offset = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${nightOf}T00:00:00Z`)) / 86_400_000) - 1
  const rows = await db.execute<AppNightRow>(APP_SLEEP_NIGHT_SQL, { ...TENANT, tz: timeZone, offset })
  const v2 = deriveNightLikeApp(rows)
  const v1 = await v1Summary(db, w, timeZone)
  const out: Displayed = { key: ref.key, iso: ref.iso, night_of: nightOf, offset, rows: rows.length, v2, v1, oracle: oracleShown(ref, w.tzOffsetHours) }
  if (v1 && v2) {
    out.totalMinusDuration = v1.total - v2.headlineMin
    out.dBedMin = wallMinutes(v2.startLocal) - wallMinutes(v1.startLocal)
    out.dWakeMin = wallMinutes(v2.endLocal) - wallMinutes(v1.endLocal)
    const stageRows = rows.filter(r => r.stage_ts_local != null).length
    if (stageRows !== v1.total)
      out.rowMismatch = `sleep.night returned ${stageRows} stage rows for night_of ${nightOf}; the v1 window holds ${v1.total}`
  }
  else if ((v1 == null) !== (v2 == null)) {
    out.rowMismatch = v1 ? `v1 window has ${v1.total} rows but sleep.night found no session for night_of ${nightOf}` : `sleep.night has ${rows.length} rows but the v1 window is empty`
  }
  if (out.rowMismatch) {
    out.windowSessions = (await db.execute<Record<string, unknown>>(
      `SELECT g.session_id, CAST(s.night_of AS VARCHAR) AS night_of, count(*) AS n, s.total_minutes,
              CAST(timezone('${timeZone}', timezone('UTC', s.ts_start)) AS VARCHAR) AS start_local,
              CAST(timezone('${timeZone}', timezone('UTC', s.ts_end)) AS VARCHAR) AS end_local
       FROM sleep_stage g JOIN sleep_session s USING (session_id)
       WHERE epoch(g.ts) >= ${w.windowStart} AND epoch(g.ts) < ${w.windowEnd}
       GROUP BY ALL ORDER BY start_local`,
    )).map(s => ({
      session_id: String(s.session_id),
      night_of: String(s.night_of),
      inWindow: Number(s.n),
      total: Number(s.total_minutes),
      startLocal: String(s.start_local),
      endLocal: String(s.end_local),
    }))
  }
  return out
}

function median(xs: number[]): number {
  if (!xs.length)
    return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// ---------------------------------------------------------------------------
// The production rig — `sleep-derive.test.ts` `rig()` fed by the mapper
// ---------------------------------------------------------------------------

const TENANT = { brand: 'ziva', familyId: 'fam', userId: 'u' } as const
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

/**
 * One capture through the production path. With `splitAt` (epoch s) the
 * capture is synced in two batches — rows before it, then the rest — the
 * way a ring that syncs in the morning and again at night delivers a day;
 * the deriver re-derives the night before each batch (ruled 2026-10-28), so
 * the two must agree with a single sync wherever the scalars agree.
 */
async function replayCapture(dump: Record<string, unknown>, deviceId: string, timeZone: string, splitAt?: number): Promise<Replay> {
  const tenant = { ...TENANT, deviceId }
  const ctx = { ...tenant, userTimezone: timeZone }

  // `icu` for the app's `timezone()` calls in the display section; it also
  // pins the session to UTC, as `bootstrapExtensions` does on the device.
  const db = new HybridDuckDB(() => createRealDuckDB(['icu']))
  await db.open()
  for (const t of TABLES) await db.execute(LOCAL_SCHEMAS[t])
  // The local-mode `v_*` DDL production's `createViews` emits per table
  // (`createViews` itself also wants the hrv/spo2/temperature tables and the
  // quality views over them, which this rig does not stage).
  for (const t of ['heart_rate', 'activity', 'activity_bucket', 'sleep_session', 'sleep_stage'] as const)
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

  const cycle = async (keep: (ts: Date) => boolean) => {
    const sleepRaw = batch.sleep_raw.filter(r => keep(r.ts))
    for (const t of FLUSHED) {
      const rows = batch[t].filter(r => keep(r.ts))
      if (rows.length)
        await buffer.push({ table: t, ...tenant, rows: rows as unknown as Record<string, unknown>[] })
    }
    if (sleepRaw.length)
      deriver.noteRaw({ ...tenant, rows: sleepRaw as unknown as Record<string, unknown>[] })
    const batchId = flusher.beginBatch('manual')
    for (const t of FLUSHED) await flusher.flush(t, 'manual', batchId)
    await deriver.derive(batchId, 'manual')
    flusher.endBatch(batchId)
  }
  if (splitAt === undefined) {
    await cycle(() => true)
  }
  else {
    await cycle(ts => ts.getTime() / 1000 < splitAt)
    await cycle(ts => ts.getTime() / 1000 >= splitAt)
  }

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
  if (reproduces(x.v1Steps))
    return 'c'
  if (reproduces(x.refScalarsV1Steps))
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
    const display: Displayed[] = []
    const counts: CaptureCounts[] = []
    const surprises: string[] = []
    const splitSync: Array<{ capture: string, splitAt: number, same: boolean, single: string[], split: string[] }> = []

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
      const today = await localToday(r.db, timeZone)
      let v1StepsReady = false

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

        // v1's exact step input: the record's own 10-min `step` total, as the
        // parity harness stages it (not the sum of its `arraySteps`).
        const v1Steps: SleepRelations = { ...DEFAULT_RELATIONS, activity: 'stg_activity_v1' }
        const ensureV1Steps = async () => {
          if (v1StepsReady)
            return
          await db.execute(`CREATE TEMP TABLE stg_activity_v1 (date BIGINT, step DOUBLE)`)
          const act = (Array.isArray(dump.activitydetails) ? dump.activitydetails : []) as Array<Record<string, unknown>>
          await insertChunks(db, 'stg_activity_v1', act.map(a => [epoch(a.date), a.step]))
          v1StepsReady = true
        }

        // Drift from the oracle (or a session where the oracle had none):
        // re-run under controlled conditions to name the cause.
        const driftsFromRef = want ? row.vsRef != null && !row.vsRef.within : ref.error != null && stats != null
        if (driftsFromRef && ref.tier != null && ref.p75 != null && ref.p90 != null) {
          await ensureV1Steps()
          const refScalars = { tier: ref.tier, p75: ref.p75, p90: ref.p90 }
          const prodScalars = { tier: tier.tier, p75, p90 }
          const x = {
            refScalars: toOutcome(want, ref.error, await rerunNight(db, ref, timeZone, refScalars, DEFAULT_RELATIONS)),
            v1Steps: toOutcome(want, ref.error, await rerunNight(db, ref, timeZone, prodScalars, v1Steps)),
            refScalarsV1Steps: toOutcome(want, ref.error, await rerunNight(db, ref, timeZone, refScalars, v1Steps)),
          }
          row.experiments = { ...x, cause: causeOf(tier.tier !== ref.tier, x) }
        }

        // Drift from the phone's own output: the empty-baseline fallback hypothesis.
        if (emb && row.vsEmbedded && !row.vsEmbedded.within) {
          await ensureV1Steps()
          const fallback = { p75: 80, p90: 120 }
          const x = {
            fallbackProdTier: toOutcome(emb, undefined, await rerunNight(db, ref, timeZone, { tier: tier.tier, ...fallback }, v1Steps)),
            fallbackRefTier: ref.tier != null
              ? toOutcome(emb, undefined, await rerunNight(db, ref, timeZone, { tier: ref.tier, ...fallback }, v1Steps))
              : undefined,
          }
          row.embeddedExperiments = { ...x, reproduced: reproduces(x.fallbackProdTier) || reproduces(x.fallbackRefTier) }
        }
        results.push(row)
        // The night as each screen would show it, from the rows just stored.
        // After the re-runs: those write only `stg_*` temp relations, never
        // `sleep_session` / `sleep_stage`, so the stored night is unchanged.
        display.push(await displayNight(r.db, ref, w, timeZone, nightOf, today))
      }
      await r.db.close()

      // Split sync: a multi-night capture delivered in two batches, cut at the
      // last reference night's window start, must land what one sync lands.
      if (nights.length > 1) {
        const splitAt = nightWindow(nights[nights.length - 1].iso, timeZone).windowStart
        const twice = await replayCapture(dump, nights[0].ring, timeZone, splitAt)
        await twice.db.close()
        const shape = (ss: StoredSession[]) => ss.map(s => `${s.night} ${s.s}-${s.e} ${s.total_minutes}m L${s.light_minutes} D${s.deep_minutes} R${s.rem_minutes}`)
        const single = shape(r.sessions)
        const split = shape(twice.sessions)
        splitSync.push({ capture: file, splitAt, same: single.join('|') === split.join('|'), single, split })
      }
    }

    if (OUT)
      writeFileSync(OUT, JSON.stringify({ results, counts, surprises, splitSync }, null, 1))

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
      + `[ref scalars: ${fmt(r.experiments?.refScalars)}; v1 step totals: ${fmt(r.experiments?.v1Steps)}; both: ${fmt(r.experiments?.refScalarsV1Steps)}]`
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
        + `fallback p75=80/p90=120 + v1 step totals reproduces embedded: ${r.embeddedExperiments?.reproduced ? 'yes' : 'no'} `
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
    console.log(`split sync (two batches, night before re-derived): ${splitSync.filter(s => s.same).length}/${splitSync.length} multi-night captures land exactly what one sync lands`)
    for (const s of splitSync.filter(x => !x.same)) {
      console.log(`  split differs ${s.capture}:`)
      for (let i = 0; i < Math.max(s.single.length, s.split.length); i++) {
        if (s.single[i] !== s.split[i])
          console.log(`    single ${s.single[i] ?? '-'}  |  split ${s.split[i] ?? '-'}`)
      }
    }
    for (const s of surprises) console.log(`  note ${s}`)

    // ---- display parity: what each screen shows for the same stored night ----
    if (DISPLAY_OUT)
      writeFileSync(DISPLAY_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), nights: display }, null, 1))
    const shown = display.filter(d => d.v1 && d.v2)
    const hm = (m: number) => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
    const clock = (local: string) => local.slice(5, 16)
    console.log(`display parity (${shown.length}/${display.length} reference nights with stored rows): v1 Day-tab total (all primary minutes) vs v2 Night durationMin (light+deep+rem)`)
    console.log(`  night            | v1 total  asleep  eff  | v2 dur    awake  wakes | delta | v1 start→end            | v2 bed→wake             | dBed dWake | oracle total/awake`)
    for (const d of shown) {
      const { v1, v2 } = d as Required<Pick<Displayed, 'v1' | 'v2'>> & Displayed
      const o = d.oracle ? `${d.oracle.total}/${d.oracle.awake}` : '-'
      const flag = Math.abs(d.dBedMin!) > 1 || Math.abs(d.dWakeMin!) > 1 ? ' <-- bed/wake differ' : ''
      console.log(`  ${d.key.padEnd(16)} | ${String(v1.total).padStart(4)} ${hm(v1.total)}  ${String(v1.asleep).padStart(4)}  ${(v1.efficiency * 100).toFixed(0).padStart(3)}% `
        + `| ${String(v2.headlineMin).padStart(4)} ${hm(v2.headlineMin)} ${String(v2.awake).padStart(4)}   ${String(v2.awakenings).padStart(3)}  `
        + `| ${String(d.totalMinusDuration).padStart(4)}  | ${clock(v1.startLocal)}→${clock(v1.endLocal)} | ${clock(v2.startLocal)}→${clock(v2.endLocal)} `
        + `| ${String(d.dBedMin).padStart(4)} ${String(d.dWakeMin).padStart(5)} | ${o}${flag}${d.rowMismatch ? ` <-- ${d.rowMismatch}` : ''}`)
    }
    // Nights where the two screens do not read the same rows: a session that
    // crosses 18:00 local. `correctNightSql` fetches to `windowEnd + FETCH_AFTER`
    // (30 min, classify.ts — v3.1's constant), so a primary block may end up
    // to ~18:30; v1's Day tab slices it at 17:59:59 and shows the rest under
    // the next day, v2 shows the whole session under the night it was derived
    // in. When the NEXT night's window then starts a new session at 18:00:01,
    // the same minutes are stored twice — reported as an overlap.
    const crossing = display.filter(x => x.rowMismatch)
    let overlapping = 0
    for (const d of crossing) {
      console.log(`  ${d.key}: ${d.rowMismatch}; sessions with a minute in the v1 window [${eveningOf(d.iso)} 18:00, ${d.iso} 18:00):`)
      const ss = d.windowSessions ?? []
      for (const [i, s] of ss.entries()) {
        const prev = ss[i - 1]
        const overlap = prev ? Math.max(0, Math.round((wallMinutes(prev.endLocal) - wallMinutes(s.startLocal)) * 10) / 10) : 0
        if (overlap > 0)
          overlapping++
        console.log(`    night_of ${s.night_of} ${s.startLocal}→${s.endLocal} ${s.total} min, ${s.inWindow} in the window${overlap > 0 ? ` <-- OVERLAPS the previous session by ${overlap} min` : ''}`)
      }
    }
    console.log(`sessions crossing 18:00 local: ${crossing.length}/${display.length} nights read differently by the two screens (v1 slices at 17:59:59, v2 shows the session whole); `
      + `${overlapping} of them have the next night's session re-claiming the same minutes`)
    const awakeMins = shown.map(d => d.v1!.awake)
    const effs = shown.map(d => d.v1!.efficiency)
    const over = (n: number) => awakeMins.filter(a => a >= n).length
    console.log(`awake minutes per night (= v1 total − v2 duration), n=${awakeMins.length}: `
      + `median ${median(awakeMins)}, mean ${(awakeMins.reduce((a, b) => a + b, 0) / awakeMins.length).toFixed(1)}, max ${Math.max(...awakeMins)}, min ${Math.min(...awakeMins)}; `
      + `nights with ≥15: ${over(15)}, ≥30: ${over(30)}, ≥60: ${over(60)}`)
    console.log(`sleep efficiency (asleep/total): median ${(median(effs) * 100).toFixed(1)}%, min ${(Math.min(...effs) * 100).toFixed(1)}%; `
      + `nights < 85%: ${effs.filter(e => e < 0.85).length}/${effs.length}`)
    const bedWakeDiffer = shown.filter(d => Math.abs(d.dBedMin!) > 1 || Math.abs(d.dWakeMin!) > 1)
    const sameRows = shown.filter(d => !d.rowMismatch)
    const displayBug = bedWakeDiffer.filter(d => !d.rowMismatch)
    console.log(`v2 bed/wake vs v1 start/end: ${shown.length - bedWakeDiffer.length}/${shown.length} within 1 min; `
      + `${sameRows.length - displayBug.length}/${sameRows.length} where both screens read the same rows `
      + `(wake − end is +1 min by construction: v1 end is the last minute's start, v2 wake is its end); `
      + `offsets bound ${Math.min(...display.map(d => d.offset))}..${Math.max(...display.map(d => d.offset))} (app input allows ≤ 365)`)
    for (const d of bedWakeDiffer)
      console.log(`  bed/wake differ ${d.key}: v1 ${d.v1!.startLocal}→${d.v1!.endLocal} v2 ${d.v2!.startLocal}→${d.v2!.endLocal}${d.rowMismatch ? ' (session crosses 18:00)' : ' <-- DISPLAY PATH'}`)

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
    // Display parity: where both screens read the same stored rows, v2's
    // bed/wake can only differ from v1's start/end by the end-of-minute
    // convention. Nights with a session crossing 18:00 are report-only above.
    expect(displayBug.map(d => d.key)).toEqual([])
  }, 600_000)
})
