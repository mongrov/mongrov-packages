/**
 * The #460 cost rewrites of the sleep-correction SQL, checked against the
 * v3.1 text they replaced (mongrov-packages#46).
 *
 *   - `globalBaselinesSql`: the `ABS(h.date - s.date) <= 30` nested-loop join
 *     → a per-reading match count from two ASOF lookups, each reading
 *     repeated that many times (the same multiset, so the same percentiles)
 *   - `detectHrTierSql`: `ROW_NUMBER` self-join → `LAG`
 *   - the sleep and activity staging views can take a `ts` bound
 *
 * The OLD SQL is kept below as literals copied from the pre-#46 source, so a
 * later edit to `sql.ts` cannot move the reference along with it.
 *
 * Runs on a synthetic fixture that always runs in CI, and on the real
 * captures the v3.1 parity suite uses when SLEEP_CAPTURES_DIR is set.
 */
import type { SqlRunner } from '../correct'

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../../__integration__/setup/real-engine'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../../core/schemas'
import { computeNightEpochs, CONF_ENVELOPE, CONF_GAP } from '../classify'
import { nightWindow } from '../night'
import { correctSleepNights, stagingBoundsFor } from '../orchestrate'
import { detectHrTierSql, globalBaselinesSql } from '../sql'
import { stagingViewsSql } from '../staging'

const CAPTURES = process.env.SLEEP_CAPTURES_DIR

/** v3.1 / pre-#46 `detectHrTierSql()`, default relations. Do not "update" this. */
const OLD_TIER_SQL = `
WITH hr_numbered AS (
    SELECT date,
           ROW_NUMBER() OVER (ORDER BY date) AS rn
    FROM stg_heartrate
    WHERE "singleHR" BETWEEN 40 AND 120
),
hr_intervals AS (
    SELECT cur.date - COALESCE(prv.date, cur.date) AS gap_sec
    FROM hr_numbered cur
    LEFT JOIN hr_numbered prv ON prv.rn = cur.rn - 1
    WHERE cur.date - COALESCE(prv.date, cur.date) BETWEEN 61 AND 3599
),
median_gap AS (
    SELECT quantile_cont(gap_sec, 0.5) AS med
    FROM hr_intervals
)
SELECT
    med AS median_interval_seconds,
    CASE WHEN med <= 360  THEN 5
         WHEN med <= 900  THEN 10
         ELSE 30
    END AS hr_interval_minutes
FROM median_gap;`

/** v3.1 / pre-#46 `globalBaselinesSql(cutoff)`, default relations. Do not "update" this. */
function oldBaselinesSql(cutoffEpoch: number): string {
  return `
WITH hr_sleep AS (
    SELECT h."singleHR" AS hr
    FROM stg_heartrate h
    INNER JOIN stg_sleep s ON ABS(h.date - s.date) <= 30
    WHERE h."singleHR" BETWEEN 40 AND 120
      AND CAST(s.quality AS INT) IN (1, 2, 3)
      AND h.date >= ${cutoffEpoch}
)
SELECT
    COALESCE((SELECT quantile_cont(hr, 0.90) FROM hr_sleep), 120) AS p90_global,
    COALESCE((SELECT quantile_cont(hr, 0.75) FROM hr_sleep), 120) AS p75_global;`
}

type Db = SqlRunner & { close?: () => Promise<void> }

async function stagedDb(): Promise<Db> {
  const db = await createRealDuckDB([])
  await db.execute(`CREATE TABLE stg_sleep (date BIGINT, quality INT, start BIGINT, "unitLength" INT)`)
  await db.execute(`CREATE TABLE stg_heartrate (date BIGINT, "singleHR" DOUBLE)`)
  await db.execute(`CREATE TABLE stg_activity (date BIGINT, step DOUBLE)`)
  return db
}

const at = (iso: string) => Date.parse(`${iso}Z`) / 1000
const DAY = 86400
const FIRST_NIGHT = '2026-05-02'
const NIGHTS = 21
const nightIso = (i: number) => new Date(Date.parse(`${FIRST_NIGHT}T00:00:00Z`) + i * DAY * 1000).toISOString().slice(0, 10)

/**
 * Three weeks of nights, deterministic. Built to reach what the rewrites
 * could get wrong:
 *   - HR exactly 30 and 31 s from sleep rows (the join edge, both sides)
 *   - duplicate sleep rows at one instant (INNER join multiplicity)
 *   - tied HR timestamps (the tier's pairing) and out-of-range HR
 *   - mixed 5- and 10-minute HR cadences with jitter, and long gaps
 *   - every firmware quality code, including ones the joins exclude
 */
async function seedSynthetic(db: Db): Promise<void> {
  let h = 1
  const rnd = () => {
    h = (h * 1103515245 + 12345) % 2147483648
    return h / 2147483648
  }
  const sleep: string[] = []
  const hr: string[] = []
  const act: string[] = []
  const base = at(`${FIRST_NIGHT}T00:00:00`) - DAY
  for (let n = 0; n < NIGHTS; n++) {
    const evening = base + n * DAY + 22 * 3600 + Math.floor(rnd() * 3600)
    // Two firmware sessions with a 20-90 min hole (the gap-recovery path).
    const s1 = evening
    const len1 = 90 + Math.floor(rnd() * 90)
    const hole = 20 + Math.floor(rnd() * 70)
    const s2 = s1 + (len1 + hole) * 60
    const len2 = 120 + Math.floor(rnd() * 150)
    for (const [start, len] of [[s1, len1], [s2, len2]] as const) {
      for (let i = 0; i <= len; i++) {
        const q = [1, 2, 2, 3, 5, 0][Math.floor(rnd() * 6)]
        sleep.push(`(${start + i * 60}, ${q}, ${start}, 1)`)
        if (rnd() < 0.05)
          sleep.push(`(${start + i * 60}, ${q}, ${start}, 1)`) // duplicate instant
      }
    }
    // HR from 18:00 to 12:00 next day, cadence 5 or 10 min by night, jittered.
    const step = n % 3 === 0 ? 600 : 300
    for (let t = base + n * DAY + 18 * 3600; t < base + (n + 1) * DAY + 12 * 3600; t += step) {
      if (rnd() < 0.03)
        t += 3600 + Math.floor(rnd() * 3600) // a gap
      const jitter = Math.floor(rnd() * 21) - 10
      const bpm = rnd() < 0.02 ? (rnd() < 0.5 ? 35 : 130) : 48 + Math.floor(rnd() * 50)
      hr.push(`(${t + jitter}, ${bpm})`)
      if (rnd() < 0.03)
        hr.push(`(${t + jitter}, ${bpm + 1})`) // tied timestamp
    }
    // Edge readings exactly 30 s and 31 s either side of a sleep row.
    hr.push(`(${s1 + 600 + 30}, 61)`, `(${s1 + 600 - 30}, 62)`, `(${s2 + 31}, 63)`, `(${s2 - 31}, 64)`)
    // Morning steps for Phase 3.
    for (let t = s2 + len2 * 60 - 3600; t < s2 + len2 * 60 + 5 * 3600; t += 60)
      act.push(`(${t}, ${Math.floor(rnd() * 3) === 0 ? Math.floor(rnd() * 80) : 0})`)
  }
  // A sleep row exactly 30 s before a baseline cutoff (the first nights'
  // window starts are cutoffs below), with a reading AT the cutoff: the
  // sleep-side bound must keep it.
  for (let n = 0; n < 3; n++) {
    const { windowStart } = computeNightEpochs(nightIso(n), 0)
    sleep.push(`(${windowStart - 30}, 2, ${windowStart - 30}, 1)`)
    hr.push(`(${windowStart}, 70)`)
  }
  for (const [table, rows] of [['stg_sleep', sleep], ['stg_heartrate', hr], ['stg_activity', act]] as const) {
    for (let i = 0; i < rows.length; i += 2000)
      await db.execute(`INSERT INTO ${table} VALUES ${rows.slice(i, i + 2000).join(',')}`)
  }
}

/** Old vs new: the tier, and the baselines at cutoffs around every night. */
async function assertEquivalent(db: Db, windows: { windowStart: number, windowEnd: number }[]): Promise<number> {
  const oldTier = await db.execute(OLD_TIER_SQL)
  const newTier = await db.execute(detectHrTierSql())
  expect(newTier).toEqual(oldTier)

  const starts = windows.map(w => w.windowStart)
  // Before all data, every night's start (and mid-night, where the cutoff
  // cuts through a session), and past the end (empty ⇒ the 120 fallback).
  const cutoffs = [0, Math.min(...starts) - 120 * DAY, ...starts, ...starts.map(s => s + 9 * 3600 + 7), Math.max(...starts) + 3 * DAY]
  for (const cutoff of cutoffs) {
    const oldB = await db.execute(oldBaselinesSql(cutoff))
    const newB = await db.execute(globalBaselinesSql(cutoff))
    expect(newB, `baselines @ ${cutoff}`).toEqual(oldB)
  }

  return windows.length
}

describe('sleep-correction SQL — #46 rewrites equal the v3.1 text', () => {
  it('synthetic three weeks: tier, and baselines at every cutoff', async () => {
    const db = await stagedDb()
    await seedSynthetic(db)
    const windows = Array.from({ length: NIGHTS }, (_, i) => computeNightEpochs(nightIso(i), 0))

    // Non-vacuous: the fixture exercises the paths the rewrites touch.
    const [{ n }] = await db.execute(`SELECT count(*)::INTEGER AS n FROM stg_heartrate h
      JOIN stg_sleep s ON ABS(h.date - s.date) <= 30`) as { n: number }[]
    expect(n).toBeGreaterThan(500)
    // Some readings match two sleep rows (the duplicates): multiplicity matters.
    const [{ twice }] = await db.execute(`SELECT count(*)::INTEGER AS twice FROM (
      SELECT h.date FROM stg_heartrate h JOIN stg_sleep s ON ABS(h.date - s.date) <= 30
      WHERE CAST(s.quality AS INT) IN (1, 2, 3) GROUP BY h.rowid, h.date HAVING count(*) > 1)`) as { twice: number }[]
    expect(twice).toBeGreaterThan(50)
    await assertEquivalent(db, windows)
    await db.close?.()
  }, 120_000)

  it('plans the baseline without a nested loop or range join', async () => {
    const db = await stagedDb()
    await seedSynthetic(db)
    const plan = async (sql: string) => (await db.execute(`EXPLAIN ${sql.replace(/;\s*$/, '')}`) as Record<string, unknown>[])
      .map(r => Object.values(r).join('\n'))
      .join('\n')
    // Pin the old side so this cannot pass vacuously on a renamed operator.
    expect(await plan(oldBaselinesSql(0))).toMatch(/NESTED_LOOP_JOIN|BLOCKWISE_NL_JOIN/)
    const text = await plan(globalBaselinesSql(0))
    expect(text).toContain('ASOF_JOIN')
    expect(text).not.toMatch(/BLOCKWISE_NL_JOIN|PIECEWISE_MERGE_JOIN|IE_JOIN/)
    await db.close?.()
  }, 60_000)

  describe.skipIf(!CAPTURES)('real captures (SLEEP_CAPTURES_DIR)', () => {
    it('every capture: tier and baselines identical around every reference night', async () => {
      const ref = JSON.parse(readFileSync(join(__dirname, 'fixtures/reference.v31.json'), 'utf8')) as {
        nights: { capture?: string, iso: string, tz: number }[]
      }
      const files = readdirSync(CAPTURES!).filter(f => f.endsWith('.json'))
      let nights = 0
      for (const file of files) {
        const capture = JSON.parse(readFileSync(join(CAPTURES!, file), 'utf8')) as Record<string, Record<string, unknown>[]>
        const db = await stagedDb()
        const ep = (v: unknown) => {
          const m = String(v).match(/(\d{4})\.(\d{2})\.(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
          return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000) : null
        }
        const lit = (v: unknown) => (v == null || v === '' || Number.isNaN(Number(v)) ? 'NULL' : String(Number(v)))
        const ins = async (table: string, rows: unknown[][]) => {
          for (let i = 0; i < rows.length; i += 1000) {
            const values = rows.slice(i, i + 1000).map(r => `(${r.map(lit).join(', ')})`).join(',')
            if (values)
              await db.execute(`INSERT INTO ${table} VALUES ${values}`)
          }
        }
        await ins('stg_sleep', (capture.sleep ?? []).map(r => [ep(r.date), r.quality, ep(r.start), r.unitLength]))
        await ins('stg_heartrate', (capture.heartrate ?? []).map(r => [ep(r.date), r.singleHR]))
        await ins('stg_activity', (capture.activitydetails ?? []).map(r => [ep(r.date), r.step]))
        const windows = ref.nights.filter(n => n.capture === file).map(n => computeNightEpochs(n.iso, n.tz))
        if (windows.length > 0) {
          await assertEquivalent(db, windows)
          nights += windows.length
        }
        await db.close?.()
      }
      expect(nights).toBeGreaterThan(50)
    }, 600_000)
  })
})

describe('staging bounds — same answer as unbounded views', () => {
  const BRAND = 'ziva'
  const FAMILY = 'fam_1'
  const ts = (e: number) => new Date(e * 1000).toISOString().slice(0, 19).replace('T', ' ')

  async function warehouse(): Promise<Db> {
    const db = await createRealDuckDB([])
    for (const t of ['sleep_raw', 'heart_rate', 'activity'] as const)
      await db.execute(LOCAL_SCHEMAS[t].replace(`CREATE TABLE ${t}`, `CREATE TABLE memory.${t}`))
    for (const t of ['heart_rate', 'activity'] as const)
      await db.execute(generateViewDdl(t, { brand: BRAND, familyId: FAMILY, localCatalog: 'memory' }))
    // Copy the synthetic staged fixture into the warehouse shapes.
    const src = await stagedDb()
    await seedSynthetic(src)
    // The warehouse keys sleep_raw by instant, so the staged duplicates collapse.
    const sleep = await src.execute('SELECT DISTINCT date, quality, start FROM stg_sleep') as { date: bigint, quality: number, start: bigint }[]
    const hr = await src.execute('SELECT date, min("singleHR") AS v FROM stg_heartrate GROUP BY date') as { date: bigint, v: number }[]
    const act = await src.execute('SELECT date, step AS v FROM stg_activity') as { date: bigint, v: number }[]
    await src.close?.()
    const chunks = async (sql: string, rows: string[]) => {
      for (let i = 0; i < rows.length; i += 2000)
        await db.execute(`${sql} VALUES ${rows.slice(i, i + 2000).join(',')}`)
    }
    // Sub-second ts on some rows: `date` rounds, and the bound must allow for it.
    await chunks(
      `INSERT INTO memory.sleep_raw (ts, ts_session_start, brand, family_id, user_id, device_id, quality, unit_length)`,
      sleep.map((r, i) => `(TIMESTAMP '${ts(Number(r.date))}' - INTERVAL ${i % 7 === 0 ? 400 : 0} MILLISECOND, '${ts(Number(r.start))}', '${BRAND}', '${FAMILY}', 'u1', 'ring_1', ${r.quality}, 1)`),
    )
    await chunks(
      `INSERT INTO memory.heart_rate (ts, brand, family_id, user_id, device_id, bpm)`,
      hr.map(r => `('${ts(Number(r.date))}', '${BRAND}', '${FAMILY}', 'u1', 'ring_1', ${Math.round(r.v)})`),
    )
    await chunks(
      `INSERT INTO memory.activity (ts, brand, family_id, user_id, device_id, steps)`,
      act.map((r, i) => `(TIMESTAMP '${ts(Number(r.date))}' - INTERVAL ${i % 5 === 0 ? 300 : 0} MILLISECOND, '${BRAND}', '${FAMILY}', 'u1', 'ring_1', ${Math.round(r.v)})`),
    )
    return db
  }

  /**
   * v3.1's Phase 2 dedupe keeps firmware over everything, but between an
   * `envelope` and a `gap` row at the same instant it has no tie-break, so
   * DuckDB picks either — run to run, with no change to the SQL (seen on the
   * captures: one night flips 0.5/envelope ↔ 0.4/gap between two runs of the
   * same text). Pre-existing and out of #46's scope (its own issue).
   *
   * So exactly that swap is masked, and nothing wider: a recovered row must
   * still be one of the two consistent pairs — envelope at CONF_ENVELOPE or
   * gap at CONF_GAP — and only which of the two it is may differ. Every other
   * field, and every non-recovered row, must match as is.
   */
  const RECOVERED_PAIRS: Record<string, number> = { envelope: CONF_ENVELOPE, gap: CONF_GAP }
  function maskEnvelopeGapSwap(r: Awaited<ReturnType<typeof correctSleepNights>>) {
    return {
      ...r,
      nights: r.nights.map(n => ({
        ...n,
        rows: n.rows?.map((row) => {
          if (!(row.source in RECOVERED_PAIRS))
            return row
          expect(row.confidence, `${row.date} ${row.source}`).toBe(RECOVERED_PAIRS[row.source])
          return { ...row, source: 'envelope|gap', confidence: Number.NaN }
        }),
      })),
    }
  }

  it('correctSleepNights over bounded views equals the unbounded run', async () => {
    const db = await warehouse()
    const scope = { brand: BRAND, familyId: FAMILY, userId: 'u1', deviceId: 'ring_1' }
    for (const [nights, cutoffDay] of [
      [['2026-05-10', '2026-05-11'], '2026-05-01'], // nights after the cutoff
      [['2026-05-04', '2026-05-15', '2026-05-20'], '2026-05-12'], // a backfill night before it
      [['2026-05-12'], '2026-05-12'], // night window starts near the cutoff
    ] as const) {
      const input = { nights: [...nights], timeZone: 'America/Los_Angeles', cutoffEpoch: at(`${cutoffDay}T00:00:00`) }
      for (const sql of stagingViewsSql(scope))
        await db.execute(sql)
      const unbounded = await correctSleepNights(db, input)
      const bounds = stagingBoundsFor(input)
      // The floors, computed here from what the queries read — NOT from the
      // bounds under test: Phase 2 and the morning vitals read from the first
      // night's window start, the baseline join from `cutoff - 30`.
      const firstWindow = Math.min(...nights.map(n => nightWindow(n, input.timeZone).windowStart))
      const floors = { stg_sleep: Math.min(input.cutoffEpoch - 30, firstWindow), stg_activity: firstWindow }
      expect(bounds.sleepFromEpoch).toBeLessThanOrEqual(floors.stg_sleep)
      expect(bounds.activityFromEpoch).toBeLessThanOrEqual(floors.stg_activity)
      for (const sql of stagingViewsSql(scope, undefined, bounds))
        await db.execute(sql)
      expect(stagingViewsSql(scope, undefined, bounds).join('\n')).toMatch(/ts >= TIMESTAMP/)
      const bounded = await correctSleepNights(db, input)
      expect(maskEnvelopeGapSwap(bounded)).toEqual(maskEnvelopeGapSwap(unbounded))
      expect(unbounded.nights.some(n => n.status === 'ok')).toBe(true)

      // And the claim itself, per relation: from each independent floor up,
      // the bounded view holds exactly the unbounded view's rows.
      for (const [rel, from] of Object.entries(floors)) {
        const q = `SELECT * FROM ${rel} WHERE date >= ${from} ORDER BY ALL`
        const b = await db.execute(q)
        for (const sql of stagingViewsSql(scope))
          await db.execute(sql)
        const u = await db.execute(q)
        expect(b, rel).toEqual(u)
        expect(u.length).toBeGreaterThan(0)
        for (const sql of stagingViewsSql(scope, undefined, bounds))
          await db.execute(sql)
      }
    }
    await db.close?.()
  }, 120_000)

  it('stagingBoundsFor: sleep from cutoff - 30 (the ±30 s join), activity from the first window', () => {
    const cutoff = at('2026-05-12T00:00:00')
    expect(stagingBoundsFor({ nights: [], timeZone: 'UTC', cutoffEpoch: cutoff })).toEqual({
      sleepFromEpoch: cutoff - 30,
      activityFromEpoch: undefined,
    })
    const later = nightWindow('2026-05-20', 'UTC').windowStart
    expect(later).toBeGreaterThan(cutoff)
    expect(stagingBoundsFor({ nights: ['2026-05-20'], timeZone: 'UTC', cutoffEpoch: cutoff }))
      .toEqual({ sleepFromEpoch: cutoff - 30, activityFromEpoch: later })
    const earlier = nightWindow('2026-05-04', 'UTC').windowStart
    expect(stagingBoundsFor({ nights: ['2026-05-20', '2026-05-04'], timeZone: 'UTC', cutoffEpoch: cutoff }))
      .toEqual({ sleepFromEpoch: earlier, activityFromEpoch: earlier })
  })

  it('a bound one second higher would drop rows the queries read (the margin is needed)', async () => {
    const db = await warehouse()
    const scope = { brand: BRAND, familyId: FAMILY, userId: 'u1', deviceId: 'ring_1' }
    // Rows whose rounded `date` equals the bound but whose ts is below it.
    const [{ d }] = await db.execute(`SELECT CAST(epoch(ts) AS BIGINT) AS d FROM memory.sleep_raw
      WHERE epoch(ts) <> floor(epoch(ts)) ORDER BY ts LIMIT 1`) as { d: bigint }[]
    for (const sql of stagingViewsSql(scope, undefined, { sleepFromEpoch: Number(d) }))
      await db.execute(sql)
    const [{ n }] = await db.execute(`SELECT count(*)::INTEGER AS n FROM stg_sleep WHERE date = ${d}`) as { n: number }[]
    expect(n).toBeGreaterThan(0)
    await db.close?.()
  }, 120_000)
})
