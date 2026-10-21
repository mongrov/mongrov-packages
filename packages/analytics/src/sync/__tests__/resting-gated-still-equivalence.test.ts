/**
 * `resting_gated_avg` — the ASOF still gate, checked against the correlated
 * sum it replaced (zivaone_app#460 P15, mongrov-packages#45).
 *
 * The baseline used to decide "still" with a correlated `SUM(steps)` over
 * `[ts - 15, ts + 15)` per clean HR reading — the quadratic shape #126
 * measured at ~33 s at 180 days. It now differences a running step total at
 * two ASOF lookups. The rewrite is meant to be a pure performance change, so
 * the bar is IDENTITY: every daily value and every quantile, for every window
 * and several zones, must match the old SQL exactly.
 *
 * `OLD_SQL` is the shipped query from before the rewrite, kept here as a
 * literal (not rebuilt from today's helpers) so a later edit to the helpers
 * cannot quietly move the reference along with the thing it checks.
 *
 * The fixture is built to reach every edge the rewrite could get wrong:
 *   - step totals straddling STILL_FLOOR, so both outcomes are common
 *   - activity rows exactly 15 minutes before / after a reading (half-open)
 *   - hours with NO activity at all (both lookups NULL or the same row)
 *   - a second ring's steps in the same minutes (the old sum was tenant-wide)
 *   - a second ring's HR readings
 *   - another user's heavy steps at the same times (must never count)
 *   - readings within 15 minutes of the scan start (the bounded slice's edge)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createQualityViews } from '../../__integration__/setup/quality-views'
import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { STILL_FLOOR } from '../../core/reading-quality'
import { buildBaselineSql } from '../baseline-compute'

const B = 'ziva'
const F = 'fam'
const U = 'u1'
const OTHER = 'u2'
// 40 days: past the 30-day scan start (so the bounded slice's left edge lands
// inside data) and enough complete days for the 30- and 90-day quantile rows.
// More would only slow the OLD query, which is the quadratic one.
const DAYS = 40

/** The shipped SQL before mongrov-packages#45. Do not "update" this. */
const OLD_SQL = `WITH daily_values AS (
        SELECT date_trunc('day', timezone(CAST($tz AS VARCHAR), timezone('UTC', m.ts))) AS day,
               avg(m.bpm) AS daily_value
        FROM v_heart_rate_clean m
        WHERE m.user_id = $userId AND m.brand = $brand AND m.family_id = $familyId
          AND m.ts > now() - (INTERVAL 1 DAY) * (CAST($windowDays AS BIGINT) + 1)
          AND m.bpm IS NOT NULL
          AND COALESCE((
            SELECT SUM(a.steps) FROM v_activity a
            WHERE a.user_id = m.user_id AND a.brand = m.brand
              AND a.family_id = m.family_id
              AND a.ts >= m.ts - INTERVAL 15 MINUTE
              AND a.ts <  m.ts + INTERVAL 15 MINUTE
          ), 0) < 50
        GROUP BY 1
        HAVING day >= date_trunc('day', timezone(CAST($tz AS VARCHAR), now())) - (INTERVAL 1 DAY) * CAST($windowDays AS BIGINT) AND day < date_trunc('day', timezone(CAST($tz AS VARCHAR), now()))
      )
      SELECT
      quantile_cont(CAST(daily_value AS DOUBLE), 0.05) AS p05,
      quantile_cont(CAST(daily_value AS DOUBLE), 0.10) AS p10,
      quantile_cont(CAST(daily_value AS DOUBLE), 0.50) AS p50,
      quantile_cont(CAST(daily_value AS DOUBLE), 0.90) AS p90,
      quantile_cont(CAST(daily_value AS DOUBLE), 0.95) AS p95,
      avg(CAST(daily_value AS DOUBLE)) AS mean,
      stddev_samp(CAST(daily_value AS DOUBLE)) AS stddev,
      count(*) AS sample_count
    FROM daily_values
    HAVING count(*) >= 20`

/** The same query, stopped at the per-day values the quantiles are taken over. */
function dailyOnly(sql: string): string {
  const cut = sql.search(/\)\s*SELECT\s+quantile_cont/)
  if (cut < 0)
    throw new Error('quantile pass not found')
  return `${sql.slice(0, cut)}) SELECT day, daily_value FROM daily_values ORDER BY day`
}

type Db = Awaited<ReturnType<typeof createRealDuckDB>>

/**
 * Seed `days` of history ending at the current minute. Deterministic: every
 * value is a hash of the minute, so a failure reproduces.
 */
async function seed(db: Db, days: number) {
  await createQualityViews(db, { brand: B, familyId: F })
  const end = `date_trunc('minute', CAST(timezone('UTC', now()) AS TIMESTAMP))`
  const minutes = days * 24 * 60
  // ring_a HR every 13 minutes, so readings fall on every offset against the
  // per-minute activity and some sit exactly 15 minutes from an activity row.
  await db.execute(`
    INSERT INTO memory.heart_rate
    SELECT ${end} - INTERVAL 1 MINUTE * i, '${B}', '${F}', '${U}', 'ring_a',
           CAST(55 + (hash(i) % 50) AS INTEGER)
    FROM range(0, ${minutes}, 13) t(i)`)
  // ring_b HR, sparser.
  await db.execute(`
    INSERT INTO memory.heart_rate
    SELECT ${end} - INTERVAL 1 MINUTE * i, '${B}', '${F}', '${U}', 'ring_b',
           CAST(60 + (hash(i * 3) % 40) AS INTEGER)
    FROM range(3, ${minutes}, 31) t(i)`)
  // ring_a activity per minute: mostly 0-1 steps with 10% bursts, so a
  // 30-minute total sits around STILL_FLOOR and both outcomes are common.
  // Every 7th hour has NO rows at all (no evidence either side).
  await db.execute(`
    INSERT INTO memory.activity
    SELECT ${end} - INTERVAL 1 MINUTE * i, '${B}', '${F}', '${U}', 'ring_a',
           CAST(CASE WHEN hash(i * 7) % 10 = 0 THEN hash(i * 11) % 20 ELSE hash(i * 13) % 2 END AS INTEGER)
    FROM range(0, ${minutes}) t(i)
    WHERE (i // 60) % 7 <> 3`)
  // ring_b activity in a few hours a day, overlapping ring_a's minutes — the
  // old sum counted it, so the new one must too.
  await db.execute(`
    INSERT INTO memory.activity
    SELECT ${end} - INTERVAL 1 MINUTE * i, '${B}', '${F}', '${U}', 'ring_b',
           CAST(hash(i * 17) % 6 AS INTEGER)
    FROM range(0, ${minutes}) t(i)
    WHERE (i // 60) % 24 IN (2, 9, 15)`)
  // Another user's heavy steps everywhere: must never enter u1's sum.
  await db.execute(`
    INSERT INTO memory.activity
    SELECT ${end} - INTERVAL 1 MINUTE * i, '${B}', '${F}', '${OTHER}', 'ring_x', 500
    FROM range(0, ${minutes}, 5) t(i)`)
}

const ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Kolkata'] as const
const WINDOWS = [7, 30, 90] as const

describe('resting_gated_avg — ASOF still gate equals the correlated sum', () => {
  let db: Db
  beforeAll(async () => {
    db = await createRealDuckDB(['icu'])
    await seed(db, DAYS)
  }, 120_000)
  afterAll(async () => {
    await db?.close?.()
  })

  it('the fixture exercises both outcomes of the gate (non-vacuous)', async () => {
    const rows = await db.execute<{ still: number, moving: number, none: number }>(`
      SELECT count(*) FILTER (WHERE s < ${STILL_FLOOR})::INTEGER AS still,
             count(*) FILTER (WHERE s >= ${STILL_FLOOR})::INTEGER AS moving,
             count(*) FILTER (WHERE s = 0)::INTEGER AS none
      FROM (
        SELECT COALESCE((SELECT sum(a.steps) FROM v_activity a
                         WHERE a.user_id = m.user_id AND a.brand = m.brand AND a.family_id = m.family_id
                           AND a.ts >= m.ts - INTERVAL 15 MINUTE AND a.ts < m.ts + INTERVAL 15 MINUTE), 0) AS s
        FROM v_heart_rate_clean m WHERE m.user_id = '${U}'
      )`)
    const r = rows[0]!
    expect(r.still).toBeGreaterThan(1000)
    expect(r.moving).toBeGreaterThan(1000)
    expect(r.none).toBeGreaterThan(100)
  }, 120_000)

  for (const tz of ZONES) {
    // 90 days only in UTC: the old query is the slow, quadratic one, and the
    // zone edges are already covered by the 7- and 30-day windows.
    for (const windowDays of WINDOWS.filter(w => w < 90 || tz === 'UTC')) {
      it(`identical daily values and quantiles — ${windowDays}d, ${tz}`, async () => {
        const params = { userId: U, brand: B, familyId: F, tz, windowDays }
        const NEW_SQL = buildBaselineSql('resting_gated_avg', windowDays)
        expect(NEW_SQL).not.toContain('SUM(a.steps)')

        const oldDays = await db.execute(dailyOnly(OLD_SQL), params)
        const newDays = await db.execute(dailyOnly(NEW_SQL), params)
        expect(oldDays.length).toBeGreaterThanOrEqual(Math.min(windowDays, DAYS - 1))
        expect(newDays).toEqual(oldDays)

        const oldQ = await db.execute<Record<string, number | bigint>>(OLD_SQL, params)
        const newQ = await db.execute<Record<string, number | bigint>>(NEW_SQL, params)
        expect(newQ).toHaveLength(oldQ.length)
        if (windowDays >= 20)
          expect(oldQ).toHaveLength(1)
        for (const [i, o] of oldQ.entries()) {
          const n = newQ[i]!
          // Quantiles and the day count are order-free: exact.
          for (const k of ['p05', 'p10', 'p50', 'p90', 'p95', 'sample_count'])
            expect(n[k], k).toEqual(o[k])
          // mean / stddev are float sums whose order follows the plan, so the
          // last bit can differ between two plans over identical inputs (the
          // daily values above are bit-identical). 1e-12 relative is far below
          // any displayed precision.
          for (const k of ['mean', 'stddev'])
            expect(Math.abs(Number(n[k]) - Number(o[k]))).toBeLessThanOrEqual(1e-12 * Math.abs(Number(o[k])))
        }
      }, 120_000)
    }
  }

  it('the gate actually excludes readings (daily mean differs from the ungated one)', async () => {
    const params = { userId: U, brand: B, familyId: F, tz: 'UTC', windowDays: 30 }
    const gated = await db.execute<{ p50: number }>(buildBaselineSql('resting_gated_avg', 30), params)
    const ungated = await db.execute<{ p50: number }>(buildBaselineSql('hr_bpm', 30), params)
    expect(Number(gated[0]!.p50)).not.toBe(Number(ungated[0]!.p50))
  }, 120_000)
})

describe('resting_gated_avg — no per-reading scan', () => {
  it('plans as lookups: no decorrelated per-reading subquery (DELIM join)', async () => {
    const db = await createRealDuckDB(['icu'])
    await seed(db, 3)
    const params = { userId: U, brand: B, familyId: F, tz: 'UTC', windowDays: 30 }
    async function plan(sql: string): Promise<string> {
      const rows = await db.execute(`EXPLAIN ${sql}`, params)
      return rows.map(r => Object.values(r as Record<string, unknown>).join('\n')).join('\n')
    }
    // DuckDB decorrelates the old per-reading SUM into a DELIM join, and that
    // is the operator the quadratic cost lived in. Pin both sides so this
    // assertion cannot pass vacuously on a DuckDB that renames it.
    expect(await plan(OLD_SQL)).toMatch(/DELIM_JOIN/)
    const text = await plan(buildBaselineSql('resting_gated_avg', 30))
    expect(text).not.toMatch(/DELIM_JOIN|DELIM_SCAN|IE_JOIN|PIECEWISE_MERGE_JOIN/)
    expect(text).toContain('ASOF_JOIN')
    await db.close?.()
  }, 60_000)

  it('cost grows ~linearly with history, not quadratically', async () => {
    async function timed(days: number): Promise<number> {
      const db = await createRealDuckDB(['icu'])
      await seed(db, days)
      const sql = buildBaselineSql('resting_gated_avg', 90)
      const params = { userId: U, brand: B, familyId: F, tz: 'UTC', windowDays: 90 }
      await db.execute(sql, params) // warm
      const t = performance.now()
      for (let i = 0; i < 3; i += 1) await db.execute(sql, params)
      const took = (performance.now() - t) / 3
      await db.close?.()
      return took
    }
    const small = await timed(25)
    const large = await timed(100)
    console.warn(`resting_gated_avg 90d: ${small.toFixed(1)} ms at 25 days, ${large.toFixed(1)} ms at 100 days`)
    // 4x the rows. Quadratic would be ~16x; allow generous noise above 4x.
    expect(large).toBeLessThan(Math.max(small * 10, 200))
  }, 180_000)
})
