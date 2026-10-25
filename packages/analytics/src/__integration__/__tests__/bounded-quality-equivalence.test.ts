/*
 * The bounded quality macros return exactly what the quality views return
 * (zivaone_app#121).
 *
 * `v_{table}_q_between(lo, hi)` exists because the `_q` views cannot be
 * pruned: they read `v_motion` and `v_wear`, window functions over each
 * tenant's whole history, so one day cost as much as a year. The macros
 * compute the same flags from padded slices. Faster is only worth anything if
 * it is the same answer, so this compares every column of every row, for
 * every table, across hundreds of windows.
 *
 * ## Why the fixture looks like this (`setup/quality-fixture.ts`)
 *
 * A first version of this check, on regular data, passed with the wear pad
 * halved, with no left motion pad, and with `onset` computed by LAG over the
 * slice — three real defects, zero disagreements. Regular data never puts an
 * edge inside a window. So each day here is built to put one there:
 *
 *   - **Onset across a gap wider than the wear pad.** Off-wrist until minute
 *     60, NO temperature for 90 minutes, back on at 150. The onset at 150 has
 *     its predecessor outside a 60-minute slice pad — the case LAG gets wrong.
 *   - **A short off-wrist dip** at 900-930, whose onset predecessor IS inside
 *     the pad, so ordinary warm-up is exercised too.
 *   - **Step bursts** every 4 hours and at 155-164, so still-windows straddle
 *     slice edges on both sides.
 *   - **Heart-rate spikes and implausible values** scattered on coprime
 *     periods, so `spike` neighbours fall either side of the base pad.
 *   - **A second user** who never stops walking. `v_motion` is tenant-scoped;
 *     if a bounded slice lost that partition, their steps would silence the
 *     first user's readings.
 *
 * Windows step every 7 minutes (coprime with the 5-minute cadence and the
 * 240-minute bursts) so every edge lands at every offset.
 */
import type { QualityOptions } from '../../core/reading-quality'
import { describe, expect, it } from 'vitest'
import {
  cleanMacroFor,
  cleanViewFor,
  MOTION_MACRO,
  QUALITY_TABLES,
  qualityMacroFor,
  qualityViewFor,
} from '../../core/reading-quality'
import { createViews, dropViews } from '../../core/warehouse'
import { at, B, F, openSeeded, U, windows } from '../setup/quality-fixture'

/** Rows present in one side and not the other, multiset-exact. Zero is the only acceptable answer. */
function symmetricDifference(bounded: string, view: string, lo: string, hi: string): string {
  const v = `SELECT * FROM ${view} WHERE ts >= ${lo} AND ts < ${hi}`
  const b = `SELECT * FROM ${bounded}(${lo}, ${hi})`
  return `SELECT count(*)::INTEGER AS n FROM (
    (${b} EXCEPT ALL ${v}) UNION ALL (${v} EXCEPT ALL ${b}))`
}

describe('bounded quality macros', () => {
  // Both motion-filter settings (zivaone_app#377): the macros and the views
  // share one body per table, and must agree whichever the app configures.
  it.each([
    ['off (default)', {}],
    ['on', { motionFilter: true }],
  ] as const)('return exactly the rows of the views, for every table, flag and window — motion filter %s', async (_label, quality: QualityOptions) => {
    const db = await openSeeded(quality)
    const wins = windows()

    for (const table of QUALITY_TABLES) {
      let qDiff = 0
      let cleanDiff = 0
      for (const [lo, hi] of wins) {
        const [q] = await db.execute<{ n: number }>(
          symmetricDifference(qualityMacroFor(table), qualityViewFor(table), lo, hi),
        )
        const [c] = await db.execute<{ n: number }>(
          symmetricDifference(cleanMacroFor(table), cleanViewFor(table), lo, hi),
        )
        qDiff += Number(q!.n)
        cleanDiff += Number(c!.n)
      }
      expect({ table, qDiff, cleanDiff }).toEqual({ table, qDiff: 0, cleanDiff: 0 })
    }

    await db.close()
  }, 900_000)

  it('the fixture actually exercises every edge — no vacuous pass', async () => {
    const db = await openSeeded()
    const [hr] = await db.execute<Record<string, number>>(`SELECT
        count(*) FILTER (WHERE spike)::INTEGER AS spike,
        count(*) FILTER (WHERE NOT plausible)::INTEGER AS implausible,
        count(*) FILTER (WHERE NOT worn)::INTEGER AS off_wrist,
        count(*) FILTER (WHERE still)::INTEGER AS still,
        count(*) FILTER (WHERE NOT still)::INTEGER AS moving
      FROM v_heart_rate_q WHERE user_id = '${U}'`)
    const [temp] = await db.execute<Record<string, number>>(
      `SELECT count(*) FILTER (WHERE scale_suspect)::INTEGER AS scale_suspect,
         count(*) FILTER (WHERE warm_up)::INTEGER AS warm_up
       FROM v_temperature_q WHERE user_id = '${U}'`,
    )
    // The onset whose predecessor lies OUTSIDE the wear pad: on-wrist at 150
    // after nothing since 55. Without a warm-up row here, the ASOF-onset path
    // is not being tested at all.
    const [gapOnset] = await db.execute<{ n: number }>(`SELECT count(*)::INTEGER AS n
      FROM v_temperature_q WHERE user_id = '${U}' AND warm_up
        AND (epoch(ts)::BIGINT / 60) % 1440 BETWEEN 150 AND 159`)

    for (const [k, v] of Object.entries({ ...hr!, ...temp!, gapOnset: gapOnset!.n }))
      expect({ [k]: Number(v) > 0 }).toEqual({ [k]: true })

    await db.close()
  }, 900_000)

  it('keep the motion partition: another user walking does not move this user\'s `still`', async () => {
    const db = await openSeeded()
    const lo = at(1440)
    const hi = at(2 * 1440)
    const [row] = await db.execute<{ bounded: number, view: number }>(`SELECT
      (SELECT count(*) FILTER (WHERE still) FROM ${qualityMacroFor('heart_rate')}(${lo}, ${hi}) WHERE user_id = '${U}')::INTEGER AS bounded,
      (SELECT count(*) FILTER (WHERE still) FROM v_heart_rate_q WHERE user_id = '${U}' AND ts >= ${lo} AND ts < ${hi})::INTEGER AS view`)
    expect(row!.bounded).toBe(row!.view)
    expect(row!.view).toBeGreaterThan(0)
    await db.close()
  }, 900_000)

  it('v_motion_between gives the same steps-in-window as v_motion, for windows inside [lo, hi)', async () => {
    const db = await openSeeded()
    // Its `cum_steps` restarts at `lo`, so rows are NOT comparable — only the
    // difference of two lookups is, and that is the contract under test. Every
    // heart-rate reading is a probe; its window is [ts - 15, ts + 15).
    const stepsVia = (motion: string, lo: string, hi: string, probeFrom: string, probeTo: string) => `
      SELECT p.user_id, p.ts,
             COALESCE(mn.cum_steps, 0) - COALESCE(mp.cum_steps, 0) AS steps
      FROM (SELECT user_id, brand, family_id, ts FROM v_heart_rate
            WHERE ts >= ${probeFrom} AND ts < ${probeTo}) p
      ASOF LEFT JOIN ${motion} mp
        ON mp.user_id = p.user_id AND mp.brand = p.brand AND mp.family_id = p.family_id
       AND p.ts - INTERVAL 15 MINUTE > mp.ts
      ASOF LEFT JOIN ${motion} mn
        ON mn.user_id = p.user_id AND mn.brand = p.brand AND mn.family_id = p.family_id
       AND p.ts + INTERVAL 15 MINUTE > mn.ts`
    const diff = (a: string, b: string) =>
      `SELECT count(*)::INTEGER AS n FROM ((${a} EXCEPT ALL ${b}) UNION ALL (${b} EXCEPT ALL ${a}))`

    let inside = 0
    let outside = 0
    let moving = 0
    for (const [lo, hi] of windows()) {
      // Probes whose whole window lies in [lo, hi): must agree exactly.
      const pFrom = `${lo} + INTERVAL 15 MINUTE`
      const pTo = `${hi} - INTERVAL 15 MINUTE`
      const [d] = await db.execute<{ n: number }>(diff(
        stepsVia(`${MOTION_MACRO}(${lo}, ${hi})`, lo, hi, pFrom, pTo),
        stepsVia('v_motion', lo, hi, pFrom, pTo),
      ))
      inside += Number(d!.n)
      // Negative control: probes whose window starts BEFORE lo break the
      // contract, and the comparison must be able to see it.
      const [o] = await db.execute<{ n: number }>(diff(
        stepsVia(`${MOTION_MACRO}(${lo}, ${hi})`, lo, hi, lo, pFrom),
        stepsVia('v_motion', lo, hi, lo, pFrom),
      ))
      outside += Number(o!.n)
      const [m] = await db.execute<{ n: number }>(
        `SELECT count(*) FILTER (WHERE steps > 0)::INTEGER AS n FROM (${stepsVia('v_motion', lo, hi, pFrom, pTo)})`,
      )
      moving += Number(m!.n)
    }

    expect(inside).toBe(0)
    // The fixture has movement inside the compared windows, and a window that
    // starts before `lo` is visibly wrong — so zero above is not vacuous.
    expect(moving).toBeGreaterThan(0)
    expect(outside).toBeGreaterThan(0)
    await db.close()
  }, 900_000)

  it('are dropped on detach and recreated on the next attach', async () => {
    const db = await openSeeded()
    await dropViews(db)
    const [gone] = await db.execute<{ n: number }>(
      `SELECT count(*)::INTEGER AS n FROM duckdb_functions() WHERE function_name LIKE '%\\_between' ESCAPE '\\'`,
    )
    expect(gone!.n).toBe(0)

    await createViews(db, { brand: B, familyId: F, localCatalog: 'memory' })
    const [back] = await db.execute<{ n: number }>(
      `SELECT count(DISTINCT function_name)::INTEGER AS n FROM duckdb_functions() WHERE function_name LIKE '%\\_between' ESCAPE '\\'`,
    )
    expect(back!.n).toBe(QUALITY_TABLES.length * 2 + 1)
    await db.close()
  }, 900_000)
})
