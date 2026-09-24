/*
 * `still` — the shipped movement FLOOR, checked against its own definition.
 *
 * ## What `still` means
 *
 * A reading is still when FEWER THAN `STILL_FLOOR` steps (50 — CREATIVE-RULES
 * §7g's 100 steps an hour, over a 30-minute window) fall in the half-open
 * window `[m.ts - 15 min, m.ts + 15 min)`.
 *
 * It used to be "no activity row with steps > 0 in that window". A worn ring
 * logs a few steps in most waking minutes, so almost no daytime reading was
 * ever still: `v_spo2_clean` and `v_hrv_clean` came back empty and both
 * screens drew nothing, with no error anywhere.
 *
 * ## Why this file was rewritten rather than patched
 *
 * It used to prove the #126 ASOF rewrite was row-for-row identical to a
 * correlated `NOT EXISTS ... steps > 0`. The floor makes that premise
 * deliberately false.
 *
 * It also never guarded the shipped predicate. It built its OWN `v_motion` and
 * compared two SQL strings written in this file, so a defect in
 * `reading-quality.ts` could not have failed it. Every case below instead
 * SELECTs `still` from the real `v_heart_rate_q` that `createViews` builds on
 * attach, and compares it with the definition computed the slow, obvious way:
 * a correlated windowed SUM.
 *
 * ## Why two lookups are the same quantity as a sum
 *
 * `v_motion` carries a running step total per tenant. `mp` is the total just
 * before the window OPENS (latest row with `ts < m.ts - 15`), `mn` just before
 * it CLOSES (latest with `ts < m.ts + 15`). `mn - mp` is exactly the steps in
 * `[m.ts - 15, m.ts + 15)` — two lookups instead of a scan per reading, which
 * keeps the #126 cost fix while changing what is measured.
 */
import { describe, expect, it } from 'vitest'
import { HybridDuckDB } from '../../core/engine'
import { STILL_FLOOR, STILL_WINDOW_MINUTES } from '../../core/reading-quality'
import { LOCAL_SCHEMAS, TABLE_NAMES } from '../../core/schemas'
import { createViews } from '../../core/warehouse'
import { createRealDuckDB } from '../setup/real-engine'

const B = 'ziva'
const F = 'fam_1'
const U = 'u1'
const D = 'ring_1'
const W = STILL_WINDOW_MINUTES
const DAYS = Number(process.env.PROBE_DAYS ?? 30)

async function ms(label: string, fn: () => Promise<unknown>): Promise<number> {
  const t = Date.now()
  await fn()
  const took = Date.now() - t
  console.warn(`${String(took).padStart(7)} ms  ${label}`)
  return took
}

/**
 * The definition, computed the slow and obvious way: sum the steps in each
 * reading's window. Tenant-scoped exactly like `v_motion` — never by device.
 */
function referenceStill(source: string): string {
  return `SELECT m.user_id, m.brand, m.family_id, m.device_id, m.ts,
       COALESCE((
         SELECT sum(a.steps) FROM v_activity a
         WHERE a.user_id = m.user_id AND a.brand = m.brand AND a.family_id = m.family_id
           AND a.ts >= m.ts - INTERVAL ${W} MINUTE
           AND a.ts <  m.ts + INTERVAL ${W} MINUTE
       ), 0) < ${STILL_FLOOR} AS still
    FROM ${source} m`
}

/** What actually ships: the `still` flag on the real quality view. */
const SHIPPED = `SELECT user_id, brand, family_id, device_id, ts, still FROM v_heart_rate_q`

/** Readings where the shipped flag and the definition disagree. Zero is the only acceptable answer. */
function disagreementSql(): string {
  return `SELECT count(*)::INTEGER AS n FROM (
    SELECT r.still AS a, s.still AS b
      FROM (${referenceStill('v_heart_rate')}) r
      JOIN (${SHIPPED}) s
        ON s.user_id = r.user_id AND s.brand = r.brand
       AND s.family_id = r.family_id AND s.device_id = r.device_id AND s.ts = r.ts
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

/** One heart-rate reading at `hhmm` on 2026-06-01. */
function hr(db: HybridDuckDB, user: string, hhmm: string, device = D): Promise<unknown> {
  return db.execute(`INSERT INTO heart_rate VALUES
    (TIMESTAMP '2026-06-01 ${hhmm}:00', '${B}','${F}','${user}','${device}', 70)`)
}

/** One activity minute carrying `n` steps at `hhmm` on 2026-06-01. */
function steps(db: HybridDuckDB, user: string, hhmm: string, n: number, device = D): Promise<unknown> {
  return db.execute(`INSERT INTO activity VALUES
    (TIMESTAMP '2026-06-01 ${hhmm}:00', '${B}','${F}','${user}','${device}', ${n})`)
}

describe('`still` is the movement floor, and the shipped view computes it', () => {
  it('pins the floor to §7g: 100 steps an hour across a 30-minute window', () => {
    // The fixture in reading-quality.test.ts clears the floor by 30 steps, so
    // it pins the DIRECTION of the gate but not its value. This pins the value,
    // so retuning STILL_STEPS_PER_HOUR fails here loudly rather than silently
    // reclassifying every reading near the boundary.
    expect(STILL_WINDOW_MINUTES).toBe(15)
    expect(STILL_FLOOR).toBe(50)
  })

  it('agrees row-for-row with the correlated windowed sum, and is far cheaper', async () => {
    const db = await openSeeded()

    // 5-minute HR against 1-minute activity. Steps are bursty rather than
    // uniform so windows land on both sides of the floor, including exactly at
    // the +/-15 minute edges where the half-open window bites.
    await db.execute(`INSERT INTO heart_rate SELECT (TIMESTAMP '${iso(day0)}' + INTERVAL (g*5) MINUTE), '${B}','${F}','${U}','${D}', 60 + (g%20)
      FROM generate_series(0, ${DAYS * 288 - 1}) AS t(g)`)
    await db.execute(`INSERT INTO activity SELECT (TIMESTAMP '${iso(day0)}' + INTERVAL (g) MINUTE), '${B}','${F}','${U}','${D}',
        CASE WHEN (g % 97) < 11 THEN 1 + (g % 9) ELSE 0 END
      FROM generate_series(0, ${DAYS * 1440 - 1}) AS t(g)`)

    await createViews(db, { brand: B, familyId: F, localCatalog: 'memory' })

    const [{ n: mismatches }] = await db.execute<{ n: number }>(disagreementSql())
    expect(mismatches).toBe(0)

    // Guard against a vacuous pass: the data must exercise BOTH outcomes, or
    // "identical" would only prove both sides are constant.
    const [{ t, f }] = await db.execute<{ t: number, f: number }>(
      `SELECT count(*) FILTER (WHERE still)::INTEGER AS t,
              count(*) FILTER (WHERE NOT still)::INTEGER AS f
         FROM (${SHIPPED})`,
    )
    console.warn(`still=true ${t}  still=false ${f}  (${DAYS}d)`)
    expect(t).toBeGreaterThan(0)
    expect(f).toBeGreaterThan(0)

    const reference = await ms('reference  correlated windowed SUM', () =>
      db.execute(`SELECT count(*) FROM (${referenceStill('v_heart_rate')}) WHERE still`))
    const shipped = await ms('shipped    v_heart_rate_q (two lookups)', () =>
      db.execute(`SELECT count(*) FROM (${SHIPPED}) WHERE still`))
    console.warn(`speedup: ${(reference / Math.max(shipped, 1)).toFixed(1)}x`)

    await db.close()
  }, 900_000)

  it('is tenant-scoped, not device-scoped: a second ring\'s steps silence the first ring\'s readings', async () => {
    // `still` keys on the tenant triple while `worn` keys on device. If the
    // motion view or its joins were ever device-scoped, steps from a second
    // ring on the same family would stop silencing the first ring's readings
    // — and only this shape catches it.
    const db = await openSeeded()
    const D2 = 'ring_2'

    // Readings on ring_1 only; every step on ring_2 only. Device-scoped would
    // call EVERY reading still, because ring_1 never records a step.
    await db.execute(`INSERT INTO heart_rate SELECT (TIMESTAMP '${iso(day0)}' + INTERVAL (g*5) MINUTE), '${B}','${F}','${U}','${D}', 70
      FROM generate_series(0, ${7 * 288 - 1}) AS t(g)`)
    await db.execute(`INSERT INTO activity SELECT (TIMESTAMP '${iso(day0)}' + INTERVAL (g) MINUTE), '${B}','${F}','${U}','${D2}',
        CASE WHEN (g % 53) < 7 THEN 30 ELSE 0 END
      FROM generate_series(0, ${7 * 1440 - 1}) AS t(g)`)

    await createViews(db, { brand: B, familyId: F, localCatalog: 'memory' })

    const [{ n }] = await db.execute<{ n: number }>(disagreementSql())
    expect(n).toBe(0)

    // Prove the cross-device silencing actually happens, and that the case is
    // not vacuous in the other direction either.
    const [{ t, f }] = await db.execute<{ t: number, f: number }>(
      `SELECT count(*) FILTER (WHERE still)::INTEGER AS t,
              count(*) FILTER (WHERE NOT still)::INTEGER AS f
         FROM (${SHIPPED}) WHERE device_id = '${D}'`,
    )
    expect(f).toBeGreaterThan(0)
    expect(t).toBeGreaterThan(0)

    await db.close()
  }, 900_000)

  it('respects the half-open window on both edges, asymmetrically', async () => {
    // One burst at 12:00, comfortably over the floor, with readings placed
    // around it. Each reading's window is [m - 15, m + 15) — half-open — so the
    // edges are NOT symmetric:
    //
    //   11:44  [11:29, 11:59)  burst outside         -> still
    //   11:45  [11:30, 12:00)  burst on the OPEN end -> still
    //   11:46  [11:31, 12:01)  burst inside          -> moving
    //   12:00  [11:45, 12:15)  burst inside          -> moving
    //   12:14  [11:59, 12:29)  burst inside          -> moving
    //   12:15  [12:00, 12:30)  burst on the CLOSED end -> moving
    //   12:16  [12:01, 12:31)  burst outside         -> still
    //
    // So a burst exactly 15 minutes BEFORE a reading marks it moving, while one
    // exactly 15 minutes AFTER does not. A symmetric rewrite (`BETWEEN`, or the
    // wrong comparison on one side) flips exactly these readings, and the bulk
    // case above would very likely still pass.
    //
    // Derived from the lookups, not recalled: for 12:15, `mp` is the latest row
    // with ts < 12:00 (none — 12:00 is not < 12:00) and `mn` the latest with
    // ts < 12:30 (the burst), so the window sees it.
    const db = await openSeeded()
    await steps(db, U, '12:00', STILL_FLOOR + 10)
    for (const t of ['11:44', '11:45', '11:46', '12:00', '12:14', '12:15', '12:16'])
      await hr(db, U, t)
    // A ZERO-STEP row beside each reading, so every window holds evidence.
    //
    // Without these the fixture carries exactly one activity row, and the
    // three readings whose window excludes it have no activity data at all —
    // so `still` is NULL for them (zivaone_app#219), and this test would be
    // measuring absence of evidence rather than the window edges it is named
    // for. Zero steps add nothing to the running total, so the arithmetic
    // below is untouched; only the evidence test changes.
    for (const t of ['11:44', '11:45', '11:46', '12:14', '12:15', '12:16'])
      await steps(db, U, t, 0)

    await createViews(db, { brand: B, familyId: F, localCatalog: 'memory' })

    const rows = await db.execute<{ ts: string, still: boolean }>(
      `SELECT strftime(ts, '%H:%M') AS ts, still FROM (${SHIPPED}) ORDER BY ts`,
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

    // Same rows, both computations.
    const [{ n }] = await db.execute<{ n: number }>(disagreementSql())
    expect(n).toBe(0)

    await db.close()
  }, 900_000)

  it('sits exactly on the floor: one step under is still, the floor itself is moving', async () => {
    // The value of the floor, which nothing else in the package pins by
    // execution. Two users on one family so their running totals are
    // independent, each with a single reading at 12:00 — window [11:45, 12:15).
    //
    // Large step counts sit OUTSIDE the window on both sides, so this exercises
    // the running-total SUBTRACTION rather than a bare sum:
    //   11:30  1000  before the window  -> must be subtracted out via `mp`
    //   12:15  1000  on the open end    -> must be excluded via `mn`
    // A version that summed from the start of history, or treated the window
    // as closed on the right, would call both readings moving.
    const db = await openSeeded()
    const below = 'u_below'
    const at = 'u_at'

    for (const [user, inside] of [[below, STILL_FLOOR - 1], [at, STILL_FLOOR]] as const) {
      await steps(db, user, '11:30', 1000)
      await steps(db, user, '11:50', 20)
      await steps(db, user, '12:05', inside - 20)
      await steps(db, user, '12:15', 1000)
      await hr(db, user, '12:00')
    }

    await createViews(db, { brand: B, familyId: F, localCatalog: 'memory' })

    const stillFor = async (user: string) =>
      (await db.execute<{ still: boolean }>(
        `SELECT still FROM (${SHIPPED}) WHERE user_id = '${user}'`,
      )).map(r => r.still)

    expect(await stillFor(below)).toEqual([true])
    expect(await stillFor(at)).toEqual([false])

    const [{ n }] = await db.execute<{ n: number }>(disagreementSql())
    expect(n).toBe(0)

    await db.close()
  }, 900_000)
})
