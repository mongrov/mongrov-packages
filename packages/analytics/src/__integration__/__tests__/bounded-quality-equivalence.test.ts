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
 * ## Why the fixture looks like this
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
import { describe, expect, it } from 'vitest'
import { HybridDuckDB } from '../../core/engine'
import {
  cleanMacroFor,
  cleanViewFor,
  QUALITY_TABLES,
  qualityMacroFor,
  qualityViewFor,
} from '../../core/reading-quality'
import { LOCAL_SCHEMAS, TABLE_NAMES } from '../../core/schemas'
import { createViews, dropViews } from '../../core/warehouse'
import { createRealDuckDB } from '../setup/real-engine'

const B = 'ziva'
const F = 'fam_1'
const U = 'u1'
const U2 = 'u2'
const DAYS = 2
const day0 = Date.UTC(2026, 5, 1)
const iso = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ')
const at = (minute: number) => `TIMESTAMP '${iso(day0 + minute * 60_000)}'`

/** Minute of the day for generated row `g` at `step` minutes. */
const MOD = (step: number) => `((g * ${step}) % 1440)`

async function openSeeded(): Promise<HybridDuckDB> {
  const db = new HybridDuckDB(() => createRealDuckDB(['icu']))
  await db.open()
  for (const t of TABLE_NAMES) await db.execute(LOCAL_SCHEMAS[t])

  const T0 = `TIMESTAMP '${iso(day0)}'`
  const every = (step: number) => `generate_series(0, ${(DAYS * 1440) / step - 1}) AS t(g)`

  // ── user 1, ring_1 ─────────────────────────────────────────────────────
  await db.execute(`INSERT INTO temperature (ts, brand, family_id, user_id, device_id, temp_c)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U}','ring_1',
      CASE WHEN ${MOD(5)} < 60 THEN 22.0
           WHEN ${MOD(5)} BETWEEN 900 AND 929 THEN 22.0
           WHEN ${MOD(5)} = 700 THEN 365.0
           ELSE 36.5 END
    FROM ${every(5)}
    WHERE ${MOD(5)} NOT BETWEEN 60 AND 149`)

  await db.execute(`INSERT INTO heart_rate (ts, brand, family_id, user_id, device_id, bpm)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U}','ring_1',
      CASE WHEN g % 211 = 0 THEN 20
           WHEN g % 97 = 0 THEN 150
           ELSE 60 + (g % 20) END
    FROM ${every(5)}`)

  await db.execute(`INSERT INTO hrv (ts, brand, family_id, user_id, device_id, hrv_ms, stress)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U}','ring_1',
      CASE WHEN g % 113 = 0 THEN 0 ELSE 40 + (g % 30) END,
      CASE WHEN g % 89 = 0 THEN NULL ELSE 20 + (g % 50) END
    FROM ${every(5)}`)

  await db.execute(`INSERT INTO spo2 (ts, brand, family_id, user_id, device_id, spo2)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U}','ring_1',
      CASE WHEN g % 131 = 0 THEN 60 ELSE 94 + (g % 5) END
    FROM ${every(5)}`)

  await db.execute(`INSERT INTO activity (ts, brand, family_id, user_id, device_id, steps)
    SELECT ${T0} + INTERVAL (g) MINUTE, '${B}','${F}','${U}','ring_1',
      CASE WHEN g % 240 < 10 THEN 40
           WHEN ${MOD(1)} BETWEEN 155 AND 164 THEN 40
           WHEN g % 97 < 3 THEN 2
           ELSE 0 END
    FROM ${every(1)}`)

  // ── user 2, ring_2: walking constantly ──────────────────────────────────
  await db.execute(`INSERT INTO activity (ts, brand, family_id, user_id, device_id, steps)
    SELECT ${T0} + INTERVAL (g) MINUTE, '${B}','${F}','${U2}','ring_2', 100
    FROM ${every(1)}`)
  await db.execute(`INSERT INTO temperature (ts, brand, family_id, user_id, device_id, temp_c)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U2}','ring_2', 36.5
    FROM ${every(5)}`)
  await db.execute(`INSERT INTO heart_rate (ts, brand, family_id, user_id, device_id, bpm)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U2}','ring_2', 110
    FROM ${every(5)}`)

  await createViews(db, { brand: B, familyId: F, localCatalog: 'memory' })
  return db
}

/** Rows present in one side and not the other, multiset-exact. Zero is the only acceptable answer. */
function symmetricDifference(bounded: string, view: string, lo: string, hi: string): string {
  const v = `SELECT * FROM ${view} WHERE ts >= ${lo} AND ts < ${hi}`
  const b = `SELECT * FROM ${bounded}(${lo}, ${hi})`
  return `SELECT count(*)::INTEGER AS n FROM (
    (${b} EXCEPT ALL ${v}) UNION ALL (${v} EXCEPT ALL ${b}))`
}

/** Every window the check runs over: 60 minutes, stepped every 7, plus whole-history edges. */
function windows(): [string, string][] {
  const out: [string, string][] = []
  for (let off = 1440; off < 2 * 1440; off += 7)
    out.push([at(off), at(off + 60)])
  // A window starting at the very first row — no history to pad into.
  out.push([at(0), at(60)])
  // One whole day, and all of it.
  out.push([at(1440), at(2 * 1440)])
  out.push([at(0), at(2 * 1440)])
  return out
}

describe('bounded quality macros', () => {
  it('return exactly the rows of the views, for every table, flag and window', async () => {
    const db = await openSeeded()
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
        count(*) FILTER (WHERE warm_up)::INTEGER AS warm_up,
        count(*) FILTER (WHERE NOT worn)::INTEGER AS off_wrist,
        count(*) FILTER (WHERE still)::INTEGER AS still,
        count(*) FILTER (WHERE NOT still)::INTEGER AS moving
      FROM v_heart_rate_q WHERE user_id = '${U}'`)
    const [temp] = await db.execute<Record<string, number>>(
      `SELECT count(*) FILTER (WHERE scale_suspect)::INTEGER AS scale_suspect FROM v_temperature_q`,
    )
    // The onset whose predecessor lies OUTSIDE the wear pad: on-wrist at 150
    // after nothing since 55. Without a warm-up row here, the ASOF-onset path
    // is not being tested at all.
    const [gapOnset] = await db.execute<{ n: number }>(`SELECT count(*)::INTEGER AS n
      FROM v_heart_rate_q WHERE user_id = '${U}' AND warm_up
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
    expect(back!.n).toBe(QUALITY_TABLES.length * 2)
    await db.close()
  }, 900_000)
})
