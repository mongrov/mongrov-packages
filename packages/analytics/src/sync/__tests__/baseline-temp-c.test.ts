/**
 * Sprint 6 T-01 — `temp_c` baselines, executed rather than asserted about.
 *
 * The existing day-first test (`baseline-compute.test.ts`) computes both
 * quantile shapes in JavaScript and then string-matches the generated SQL for
 * `quantile_cont(daily_value, ...)`. That proves the arithmetic claim and that
 * we spelled the right function name. It does not prove the query returns
 * day-first numbers, because it never runs it.
 *
 * T-01's acceptance is "identical semantics to spo2" plus "`baseline.get`
 * returns p10/p50/p90", so this executes the real builder against real DuckDB
 * with seeded temperature readings and reads the percentiles back.
 *
 * It covers three things that only appear when the SQL actually runs:
 *   - day-first: an intra-day dip must not become the bottom of the band
 *   - `sample_count` counts DAYS, not readings
 *   - the >= 20-day gate suppresses the row entirely
 */
import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { BASELINE_MIN_DAYS } from '../../core/metric_metadata'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../core/schemas'
import { buildBaselineSql } from '../baseline-compute'

const BRAND = 'ziva'
const FAMILY = 'fam_1'
const USER = 'alice'
const DEVICE = 'ring_1'
const TZ = 'America/Los_Angeles'

type DB = Awaited<ReturnType<typeof createRealDuckDB>>

type BaselineRow = {
  p05: number | null
  p10: number | null
  p50: number | null
  p90: number | null
  p95: number | null
  mean: number | null
  /** DuckDB `count(*)` is BIGINT, which the driver hands back as a BigInt. */
  sample_count: bigint | null
}

async function boot(): Promise<DB> {
  const db = await createRealDuckDB(['icu'])
  await db.execute(
    LOCAL_SCHEMAS.temperature.replace(
      'CREATE TABLE temperature',
      'CREATE TABLE memory.temperature',
    ),
  )
  // The baseline reads `v_temperature`, not the raw table — union views are
  // what `attach()` creates and what every query targets. Local mode, so the
  // view degrades to a plain local SELECT.
  await db.execute(
    generateViewDdl('temperature', { brand: BRAND, familyId: FAMILY, localCatalog: 'memory' }),
  )
  return db
}

/**
 * `days` local days of readings. Each day holds four readings at 37 C and one
 * dip at `dipC`, so the DAILY mean sits just under 37 while the raw reading
 * distribution has a long tail down to the dip.
 *
 * Whole numbers because `temp_c` is INTEGER — the current ring emits
 * whole-degree Celsius and the mapper stores it verbatim, expecting daily
 * averaging to smooth the discretisation. Seeding 36.8 here silently stored
 * 37 and made the expected mean wrong, which is worth knowing before anyone
 * writes a fractional threshold against this column.
 *
 * Readings are placed at 12:00 local (20:00 UTC) so every one lands
 * unambiguously inside its local day — this test is about day-first
 * aggregation, not about the midnight boundary, which
 * `param-casts.test.ts` covers.
 */
async function seed(db: DB, days: number, dipC: number): Promise<void> {
  for (let d = 0; d < days; d++) {
    const values = [37, 37, dipC, 37, 37]
    for (let i = 0; i < values.length; i++) {
      // Relative to now, not fixed calendar dates: the builder filters on
      // `ts > now() - INTERVAL 1 DAY * $windowDays`, so a hard-coded month
      // silently falls outside the window as soon as the wall clock moves
      // past it — which is exactly what happened on the first run of this.
      const day = new Date()
      day.setUTCDate(day.getUTCDate() - d)
      const stamp = `${day.toISOString().slice(0, 10)} 20:${String(10 + i).padStart(2, '0')}:00`
      await db.execute(
        `INSERT INTO memory.temperature (ts, brand, family_id, user_id, device_id, temp_c)
         VALUES (CAST($ts AS TIMESTAMP), $brand, $fam, $user, $dev, $v)`,
        {
          // 20:00 UTC == 12:00/13:00 local, safely inside its local day.
          ts: stamp,
          brand: BRAND,
          fam: FAMILY,
          user: USER,
          dev: DEVICE,
          v: values[i],
        },
      )
    }
  }
}

async function computeBaseline(db: DB, windowDays: 7 | 30 | 90): Promise<BaselineRow[]> {
  return db.execute<BaselineRow>(buildBaselineSql('temp_c', windowDays), {
    userId: USER,
    brand: BRAND,
    familyId: FAMILY,
    tz: TZ,
    windowDays,
  })
}

describe('temp_c baseline (T-01)', () => {
  it('is in the computed set, with the avg daily aggregate', async () => {
    const { getBaselineMetricIds, baselineAggregateFor } = await import('../../core/metric_metadata')
    expect(getBaselineMetricIds()).toContain('temp_c')
    expect(baselineAggregateFor('temp_c')).toBe('avg')
  })

  it('quantiles days, not readings — an intra-day dip stays out of the band', async () => {
    const db = await boot()
    // 2026-06 has 30 days; the window covers all of them.
    await seed(db, 25, 35)

    const rows = await computeBaseline(db, 30)
    expect(rows).toHaveLength(1)
    const row = rows[0]!

    // Every day has the same shape, so every DAILY mean is identical:
    // (37*4 + 35) / 5 = 36.6. Note the daily value IS fractional even though
    // every stored reading is an integer — which is the mapper's stated
    // reason for tolerating an INTEGER column.
    const dailyMean = (37 * 4 + 35) / 5
    expect(row.p10).toBeCloseTo(dailyMean, 4)
    expect(row.p50).toBeCloseTo(dailyMean, 4)
    expect(row.p90).toBeCloseTo(dailyMean, 4)

    // The regression this guards: quantiling raw readings would put p10 on
    // the 35.0 dip, describing the user's "usual" as a temperature they hit
    // once a day for a minute.
    expect(row.p10).not.toBeCloseTo(35, 1)

    await db.close?.()
  })

  it('counts DAYS in sample_count, not readings', async () => {
    const db = await boot()
    await seed(db, 25, 35) // 25 days x 5 readings = 125 rows

    const rows = await computeBaseline(db, 30)
    expect(Number(rows[0]!.sample_count)).toBe(25)

    await db.close?.()
  })

  it(`returns no row below the ${BASELINE_MIN_DAYS}-day gate`, async () => {
    const db = await boot()
    await seed(db, BASELINE_MIN_DAYS - 1, 35)

    // HAVING count(*) >= BASELINE_MIN_DAYS suppresses the whole row rather
    // than writing an under-evidenced band.
    expect(await computeBaseline(db, 30)).toHaveLength(0)

    await db.close?.()
  })

  it('admits the row exactly at the gate', async () => {
    const db = await boot()
    await seed(db, BASELINE_MIN_DAYS, 35)

    const rows = await computeBaseline(db, 30)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0]!.sample_count)).toBe(BASELINE_MIN_DAYS)

    await db.close?.()
  })
})
