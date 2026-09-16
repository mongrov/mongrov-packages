/*
 * #126 — can `still` be computed set-based without changing a single row?
 *
 * The shipped `still` is a correlated NOT EXISTS against `v_activity`,
 * evaluated per reading over a two-sided +/-15 minute window. It is the
 * dominant cost of every `v_*_clean` scan (measured: 1 ms -> 32,958 ms for
 * v_heart_rate_clean at 180 days).
 *
 * The candidate replaces it with two ASOF joins against the motion minutes:
 * the latest motion at-or-before the reading, and the earliest motion strictly
 * after it.
 *
 * ## Why that is the same predicate
 *
 * Shipped window is half-open: `a.ts >= m.ts - 15` AND `a.ts < m.ts + 15`.
 * Split it at `m.ts`:
 *   left  = motion in [m.ts-15, m.ts]  -> largest such is `prev` (a.ts <= m.ts)
 *   right = motion in (m.ts, m.ts+15)  -> smallest such is `next` (a.ts >  m.ts)
 * so
 *   still  <=>  (prev IS NULL OR prev <  m.ts - 15 min)
 *          AND  (next IS NULL OR next >= m.ts + 15 min)
 *
 * The `>=` on the right edge is what preserves the half-open window. Getting
 * it wrong flips exactly the readings that sit 15 minutes before a step.
 *
 * ## The scoping trap
 *
 * `STILL` is TENANT-scoped (user_id, brand, family_id) — deliberately, to
 * match the rules' `resting` join — while `WEAR_JOIN` right next to it is
 * DEVICE-scoped. The ASOF joins below must key on the tenant triple only. Two
 * devices on one family is where a device-scoped rewrite would silently
 * diverge, so the second case seeds exactly that.
 *
 * This probe asserts EQUIVALENCE first and reports timings second. A faster
 * predicate that changes a single row is worthless.
 */
import { describe, expect, it } from 'vitest'
import { HybridDuckDB } from '../../core/engine'
import { LOCAL_SCHEMAS, TABLE_NAMES } from '../../core/schemas'
import { createViews } from '../../core/warehouse'
import { createRealDuckDB } from '../setup/real-engine'

const B = 'ziva'
const F = 'fam_1'
const U = 'u1'
const D = 'ring_1'
const DAYS = Number(process.env.PROBE_DAYS ?? 30)

async function ms(label: string, fn: () => Promise<unknown>): Promise<number> {
  const t = Date.now()
  await fn()
  const took = Date.now() - t
  console.warn(`${String(took).padStart(7)} ms  ${label}`)
  return took
}

/** Motion minutes, tenant-scoped — the set `still` is really asking about. */
const MOTION_VIEW = `CREATE OR REPLACE VIEW v_motion AS
  SELECT user_id, brand, family_id, ts FROM v_activity WHERE steps > 0`

/**
 * Candidate `still` for one source view, as two ASOF joins.
 * Mirrors what would replace `STILL` in reading-quality.ts.
 */
function candidateStill(source: string): string {
  return `SELECT m.user_id, m.brand, m.family_id, m.device_id, m.ts,
       (p.ts IS NULL OR p.ts <  m.ts - INTERVAL 15 MINUTE)
   AND (n.ts IS NULL OR n.ts >= m.ts + INTERVAL 15 MINUTE) AS still
    FROM ${source} m
    ASOF LEFT JOIN v_motion p
      ON p.user_id = m.user_id AND p.brand = m.brand AND p.family_id = m.family_id
     AND m.ts >= p.ts
    ASOF LEFT JOIN v_motion n
      ON n.user_id = m.user_id AND n.brand = m.brand AND n.family_id = m.family_id
     AND m.ts < n.ts`
}

/** The shipped predicate, lifted verbatim so both sides are computed alike. */
function shippedStill(source: string): string {
  return `SELECT m.user_id, m.brand, m.family_id, m.device_id, m.ts,
       NOT EXISTS (
         SELECT 1 FROM v_activity a
         WHERE a.user_id = m.user_id AND a.brand = m.brand AND a.family_id = m.family_id
           AND a.steps > 0
           AND a.ts >= m.ts - INTERVAL 15 MINUTE
           AND a.ts <  m.ts + INTERVAL 15 MINUTE) AS still
    FROM ${source} m`
}

/** Rows where the two disagree. Zero is the only acceptable answer. */
function disagreementSql(source: string): string {
  return `SELECT count(*)::INTEGER AS n FROM (
    SELECT s.ts, s.still AS a, c.still AS b
      FROM (${shippedStill(source)}) s
      JOIN (${candidateStill(source)}) c
        ON c.user_id = s.user_id AND c.brand = s.brand
       AND c.family_id = s.family_id AND c.device_id = s.device_id AND c.ts = s.ts
  ) WHERE a IS DISTINCT FROM b`
}

async function openSeeded(): Promise<HybridDuckDB> {
  const db = new HybridDuckDB(() => createRealDuckDB(['icu']))
  await db.open()
  for (const t of TABLE_NAMES) await db.execute(LOCAL_SCHEMAS[t])
  return db
}

const day0 = Date.UTC(2026, 5, 1)
const iso = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ')

describe('#126 — set-based `still` must be row-for-row identical', () => {
  it('agrees with the correlated predicate, and is far cheaper', async () => {
    const db = await openSeeded()

    // 5-minute HR, 1-minute activity. Steps are bursty rather than uniform so
    // readings land at every offset from a step boundary — including exactly
    // 15 minutes either side, which is where the edge semantics bite.
    await db.execute(`INSERT INTO heart_rate SELECT (TIMESTAMP '${iso(day0)}' + INTERVAL (g*5) MINUTE), '${B}','${F}','${U}','${D}', 60 + (g%20)
      FROM generate_series(0, ${DAYS * 288 - 1}) AS t(g)`)
    await db.execute(`INSERT INTO temperature SELECT (TIMESTAMP '${iso(day0)}' + INTERVAL (g*30) MINUTE), '${B}','${F}','${U}','${D}', 36.5
      FROM generate_series(0, ${DAYS * 48 - 1}) AS t(g)`)
    await db.execute(`INSERT INTO activity SELECT (TIMESTAMP '${iso(day0)}' + INTERVAL (g) MINUTE), '${B}','${F}','${U}','${D}',
        CASE WHEN (g % 97) < 11 THEN 1 + (g % 5) ELSE 0 END
      FROM generate_series(0, ${DAYS * 1440 - 1}) AS t(g)`)

    await createViews(db, { brand: B, familyId: F, localCatalog: 'memory' })
    await db.execute(MOTION_VIEW)

    const [{ n: hr }] = await db.execute<{ n: number }>(`SELECT count(*)::INTEGER n FROM heart_rate`)
    const [{ n: moving }] = await db.execute<{ n: number }>(`SELECT count(*)::INTEGER n FROM v_motion`)
    console.warn(`rows: heart_rate=${hr} motion=${moving} (${DAYS}d)`)

    // The claim under test.
    const [{ n: mismatches }] = await db.execute<{ n: number }>(disagreementSql('v_heart_rate'))
    expect(mismatches).toBe(0)

    // Guard against a vacuous pass: the data must actually exercise both
    // outcomes, or "identical" would only prove both sides are constant.
    const [{ t, f }] = await db.execute<{ t: number, f: number }>(
      `SELECT count(*) FILTER (WHERE still)::INTEGER AS t,
              count(*) FILTER (WHERE NOT still)::INTEGER AS f
         FROM (${candidateStill('v_heart_rate')})`,
    )
    console.warn(`still=true ${t}  still=false ${f}`)
    expect(t).toBeGreaterThan(0)
    expect(f).toBeGreaterThan(0)

    const shipped = await ms('shipped  correlated NOT EXISTS', () =>
      db.execute(`SELECT count(*) FROM (${shippedStill('v_heart_rate')}) WHERE still`))
    const candidate = await ms('candidate two ASOF joins     ', () =>
      db.execute(`SELECT count(*) FROM (${candidateStill('v_heart_rate')}) WHERE still`))
    console.warn(`speedup: ${(shipped / Math.max(candidate, 1)).toFixed(1)}x`)

    await db.close()
  }, 900_000)

  it('stays identical across two devices in one family (tenant-scoped, not device-scoped)', async () => {
    // `still` keys on the tenant triple while the wear join keys on device.
    // If a rewrite accidentally scopes `still` per device, a second ring's
    // steps stop silencing the first ring's readings — and only this shape
    // catches it.
    const db = await openSeeded()
    const D2 = 'ring_2'

    // Readings on ring_1 only; steps on ring_2 only. Device-scoped would call
    // every reading `still`; tenant-scoped must not.
    await db.execute(`INSERT INTO heart_rate SELECT (TIMESTAMP '${iso(day0)}' + INTERVAL (g*5) MINUTE), '${B}','${F}','${U}','${D}', 70
      FROM generate_series(0, ${7 * 288 - 1}) AS t(g)`)
    await db.execute(`INSERT INTO temperature SELECT (TIMESTAMP '${iso(day0)}' + INTERVAL (g*30) MINUTE), '${B}','${F}','${U}','${D}', 36.5
      FROM generate_series(0, ${7 * 48 - 1}) AS t(g)`)
    await db.execute(`INSERT INTO activity SELECT (TIMESTAMP '${iso(day0)}' + INTERVAL (g) MINUTE), '${B}','${F}','${U}','${D2}',
        CASE WHEN (g % 53) < 7 THEN 3 ELSE 0 END
      FROM generate_series(0, ${7 * 1440 - 1}) AS t(g)`)

    await createViews(db, { brand: B, familyId: F, localCatalog: 'memory' })
    await db.execute(MOTION_VIEW)

    const [{ n }] = await db.execute<{ n: number }>(disagreementSql('v_heart_rate'))
    expect(n).toBe(0)

    // And prove the cross-device silencing actually happens, so the case is
    // not vacuous.
    const [{ f }] = await db.execute<{ f: number }>(
      `SELECT count(*) FILTER (WHERE NOT still)::INTEGER AS f FROM (${candidateStill('v_heart_rate')})`,
    )
    expect(f).toBeGreaterThan(0)

    await db.close()
  }, 900_000)

  it('agrees on the exact +/-15 minute edges, including their asymmetry', async () => {
    // One step at 12:00, readings placed around it. Each reading's window is
    // [m-15, m+15) — half-open — so the edges are NOT symmetric:
    //
    //   11:44  [11:29, 11:59)  step outside          -> still
    //   11:45  [11:30, 12:00)  step on the OPEN end  -> still
    //   11:46  [11:31, 12:01)  step inside           -> moving
    //   12:00  [11:45, 12:15)  step inside           -> moving
    //   12:14  [11:59, 12:29)  step inside           -> moving
    //   12:15  [12:00, 12:30)  step on the CLOSED end-> moving
    //   12:16  [12:01, 12:31)  step outside          -> still
    //
    // So a step exactly 15 min BEFORE a reading marks it moving, while one
    // exactly 15 min AFTER does not. That falls out of the shipped window and
    // is pinned here deliberately: it is exactly what a naive symmetric
    // rewrite (`BETWEEN -15 AND +15`, or `>` instead of `>=` on the right)
    // would get wrong, and the bulk cases above would likely still pass.
    //
    // I got this backwards on the first draft by reading the offsets from the
    // step's point of view rather than the reading's.
    const db = await openSeeded()

    await db.execute(`INSERT INTO temperature VALUES (TIMESTAMP '2026-06-01 11:00:00', '${B}','${F}','${U}','${D}', 36.5)`)
    await db.execute(`INSERT INTO activity VALUES (TIMESTAMP '2026-06-01 12:00:00', '${B}','${F}','${U}','${D}', 5)`)
    for (const t of [
      '11:44:00',
      '11:45:00',
      '11:46:00',
      '12:00:00',
      '12:14:00',
      '12:15:00',
      '12:16:00',
    ])
      await db.execute(`INSERT INTO heart_rate VALUES (TIMESTAMP '2026-06-01 ${t}', '${B}','${F}','${U}','${D}', 70)`)

    await createViews(db, { brand: B, familyId: F, localCatalog: 'memory' })
    await db.execute(MOTION_VIEW)

    const rows = await db.execute<{ ts: string, still: boolean }>(
      `SELECT strftime(ts, '%H:%M') AS ts, still FROM (${candidateStill('v_heart_rate')}) ORDER BY ts`,
    )
    expect(rows.map(r => [r.ts, r.still])).toEqual([
      ['11:44', true],
      ['11:45', true],
      ['11:46', false],
      ['12:00', false],
      ['12:14', false],
      ['12:15', false],
      ['12:16', true],
    ])

    // Same rows, both predicates.
    const [{ n }] = await db.execute<{ n: number }>(disagreementSql('v_heart_rate'))
    expect(n).toBe(0)

    await db.close()
  }, 900_000)
})
