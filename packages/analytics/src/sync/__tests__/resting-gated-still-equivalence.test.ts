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
 * The PRIMARY check is per reading: the set of readings that pass the gate,
 * old vs new, over every reading the scan admits (including the ones within
 * 15 minutes of the scan start, where the bounded slice's pad matters). The
 * daily values are checked once more end to end; the quantile pass after
 * them is unchanged code and is not re-run against the old SQL.
 *
 * The fixture is built to reach every edge the rewrite could get wrong:
 *   - step totals straddling STILL_FLOOR, so both outcomes are common
 *   - edge rows (60 steps, enough to flip a reading) at exactly ts - 15 min,
 *     ts + 15 min and one second either side of each, on HR readings both on
 *     the minute and at second offsets — the half-open window, to the second
 *   - those edge rows share their minute with another ring's row carrying a
 *     different step count (RANGE, not ROWS, framing of the running total)
 *   - hours with NO activity at all (both lookups NULL or the same row)
 *   - a second ring's steps in the same minutes (the old sum was tenant-wide)
 *   - another user's, another brand's and another family's heavy steps at
 *     the same minutes (must never count)
 *   - two rows at one instant with different steps, in both insertion
 *     orders, right before a reading (RANGE, not ROWS, framing)
 *   - readings just after each window's scan start whose window reaches a
 *     row just before it (the running total's pre-start pad)
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
/** Enough steps on its own to make a reading moving. */
const EDGE_STEPS = STILL_FLOOR + 10

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

/**
 * The same query, stopped at the readings that pass the gate: one row per
 * reading the scan admits and the gate keeps, before any day grouping.
 * Both SQLs share this outer shape, so the same rewrite applies to each.
 */
function perReading(sql: string): string {
  const select = /SELECT date_trunc\('day'[\s\S]*?AS daily_value/
  const tail = /GROUP BY 1[\s\S]*$/
  if (!select.test(sql) || !tail.test(sql))
    throw new Error('daily_values shape not found')
  return sql
    .replace(select, 'SELECT m.ts, m.device_id, m.bpm')
    .replace(tail, ') SELECT * FROM daily_values ORDER BY ALL')
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
  // ring_b HR, sparser, and 17 s off the minute: its window edges fall
  // between the per-minute activity rows.
  await db.execute(`
    INSERT INTO memory.heart_rate
    SELECT ${end} - INTERVAL 1 MINUTE * i + INTERVAL 17 SECOND, '${B}', '${F}', '${U}', 'ring_b',
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
  // Another user's, another brand's and another family's heavy steps at the
  // same minutes: none may ever enter u1's sum. (Local-mode union views carry
  // no tenant filter, so all three are visible to v_activity.)
  for (const [brand, fam, user] of [[B, F, OTHER], ['other_brand', F, U], [B, 'other_fam', U]]) {
    await db.execute(`
      INSERT INTO memory.activity
      SELECT ${end} - INTERVAL 1 MINUTE * i, '${brand}', '${fam}', '${user}', 'ring_x', 500
      FROM range(0, ${minutes}, 5) t(i)`)
  }
  // Edge rows: for one HR reading in eight (both rings; sparse, because each
  // row also lands in its neighbours' windows), one EDGE_STEPS row at one of
  // ts - 15 min - 1 s, ts - 15 min, ts - 15 min + 1 s (first three: the
  // middle two are inside the half-open window) or ts + 15 min - 1 s,
  // ts + 15 min, ts + 15 min + 1 s (only the first inside). EDGE_STEPS alone
  // passes STILL_FLOOR, so whether the row counts decides the reading.
  //
  // A second ring at every edge instant, 1 step: the row an ASOF lookup lands
  // on is then one of two tied rows with different step counts. RANGE framing
  // gives both the same total; a ROWS frame gives one a partial total, and
  // which tied row DuckDB's ASOF returns depends on insertion order — so half
  // the instants get the tie row first and half get it second.
  const edges = `SELECT h.ts + INTERVAL 1 SECOND * o.s AS ts, epoch(h.ts) AS e
    FROM memory.heart_rate h
    JOIN (VALUES (0, -901), (1, -900), (2, -899), (3, 899), (4, 900), (5, 901)) o(k, s)
      ON o.k = hash(epoch(h.ts)) % 48`
  const insert = (device: string, steps: number, half: number) => db.execute(`
    INSERT OR IGNORE INTO memory.activity
    SELECT ts, '${B}', '${F}', '${U}', '${device}', ${steps} FROM (${edges}) WHERE hash(e * 7) % 2 = ${half}`)
  await insert('ring_tie', 1, 0)
  await insert('ring_edge', EDGE_STEPS, 0)
  await insert('ring_edge', EDGE_STEPS, 1)
  await insert('ring_tie', 1, 1)

  // Isolated ties, before the seeded history (so only the 90-day scan sees
  // them, and nothing else is near): two rows at one instant, 70 and 5
  // steps, inserted in both orders, and a reading 30 s later whose `mn`
  // lookup lands on that instant. Only the two rings TOGETHER pass the floor
  // (moving). Had the running total kept tied rows apart, which one DuckDB's
  // ASOF returns follows insertion order (measured), and under a ROWS frame
  // the 70-then-5 order returned the 5-step row's partial total (still).
  if (days < 90) {
    for (const [at, first, second] of [[days + 10, 70, 5], [days + 15, 5, 70]]) {
      const t = `${end} - INTERVAL ${at} DAY`
      await db.execute(`INSERT INTO memory.activity VALUES (${t}, '${B}', '${F}', '${U}', 'ring_t1', ${first})`)
      await db.execute(`INSERT INTO memory.activity VALUES (${t}, '${B}', '${F}', '${U}', 'ring_t2', ${second})`)
      await db.execute(`INSERT INTO memory.heart_rate VALUES (${t} + INTERVAL 30 SECOND, '${B}', '${F}', '${U}', 'ring_t', 70)`)
    }
  }

  // The slice's pad. For each tested window, readings 5, 8 and 11 minutes
  // after that window's scan start, with an EDGE_STEPS row 3 minutes BEFORE
  // the scan start — inside their ±15 min windows, outside the scan. Only
  // the pre-start pad puts that row in the running total. (Positions are
  // relative to seed time; the scan starts at query time, a few seconds
  // later, which these margins absorb.)
  for (const [, w] of CASES) {
    const start = `${end} - INTERVAL ${w + 1} DAY`
    await db.execute(`
      INSERT INTO memory.heart_rate
      SELECT ${start} + INTERVAL 1 MINUTE * o, '${B}', '${F}', '${U}', 'ring_pad', 70
      FROM (VALUES (5), (8), (11)) t(o)`)
    await db.execute(`
      INSERT INTO memory.activity
      VALUES (${start} - INTERVAL 3 MINUTE, '${B}', '${F}', '${U}', 'ring_pad', ${EDGE_STEPS})`)
  }
}

// Each window once, each in a different zone: the per-reading check is
// zone-free, and the zones only change the day grouping.
const CASES = [['America/Los_Angeles', 7], ['Asia/Kolkata', 30], ['UTC', 90]] as const

describe('resting_gated_avg — ASOF still gate equals the correlated sum', () => {
  let db: Db
  beforeAll(async () => {
    db = await createRealDuckDB(['icu'])
    await seed(db, DAYS)
  }, 120_000)
  afterAll(async () => {
    await db?.close?.()
  })

  for (const [tz, windowDays] of CASES) {
    it(`identical gate per reading, and identical daily values — ${windowDays}d, ${tz}`, async () => {
      const NEW_SQL = buildBaselineSql('resting_gated_avg', windowDays)
      expect(NEW_SQL).not.toContain('SUM(a.steps)')

      // Primary: every admitted reading gets the same verdict. No `$tz` here —
      // the per-reading form never reaches the day grouping.
      const scan = { userId: U, brand: B, familyId: F, windowDays }
      const oldKept = await db.execute(perReading(OLD_SQL), scan)
      const newKept = await db.execute(perReading(NEW_SQL), scan)
      expect(newKept.length).toBe(oldKept.length)
      expect(newKept).toEqual(oldKept)
      // Non-vacuous: the gate keeps many and drops many in this scan.
      const [{ n }] = await db.execute<{ n: number }>(
        `SELECT count(*)::INTEGER AS n FROM v_heart_rate_clean
         WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
           AND ts > now() - (INTERVAL 1 DAY) * (CAST($windowDays AS BIGINT) + 1)`,
        scan,
      )
      expect(oldKept.length).toBeGreaterThan(n * 0.2)
      expect(oldKept.length).toBeLessThan(n * 0.8)

      // End to end through the day grouping, in this zone. The quantile pass
      // that follows is unchanged code, so it is not re-run on the old SQL;
      // nor is the 90-day UTC case's day grouping (UTC has no zone edge, and
      // the old query is the slow one).
      if (tz === 'UTC')
        return
      const params = { ...scan, tz }
      const newDays = await db.execute(dailyOnly(NEW_SQL), params)
      expect(newDays.length).toBeGreaterThanOrEqual(Math.min(windowDays, DAYS - 1))
      expect(newDays).toEqual(await db.execute(dailyOnly(OLD_SQL), params))
    }, 120_000)
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
