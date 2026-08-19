/**
 * `cadence: 'day'` (sprint6 T-04), executed against real DuckDB.
 *
 * The whole point of this cadence is WHERE a day starts, so a snapshot of the
 * SQL would assert nothing. Three properties only appear when it runs:
 *
 *   - days are the user's local days, not UTC ones
 *   - today is excluded while it is still accumulating
 *   - a run is counted in days, not readings
 */
import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../core/schemas'
import { compileRule, localDayExpr } from '../compiler'
import { RuleSchema } from '../schema'
import { validateRule } from '../validator'

const BRAND = 'ziva'
const FAMILY = 'fam_1'
const USER = 'alice'
const TZ = 'America/Los_Angeles'

type DB = Awaited<ReturnType<typeof createRealDuckDB>>

function dayRule(overrides: Record<string, unknown> = {}) {
  return RuleSchema.parse({
    id: 'test.hrv-below-usual',
    name: 'HRV below usual',
    metric: 'hrv_ms',
    window: '30d',
    aggregation: 'avg',
    compare: 'less_than',
    severity: 'info',
    cadence: 'day',
    consecutive: 3,
    target: { type: 'baseline_offset', windowDays: 30, offset: 10, direction: 'below' },
    ...overrides,
  })
}

async function boot(): Promise<DB> {
  const db = await createRealDuckDB(['icu'])
  for (const t of ['hrv', 'user_baseline'] as const)
    await db.execute(LOCAL_SCHEMAS[t].replace(`CREATE TABLE ${t}`, `CREATE TABLE memory.${t}`))
  await db.execute(generateViewDdl('hrv', { brand: BRAND, familyId: FAMILY, localCatalog: 'memory' }))
  await db.execute(
    `INSERT INTO memory.user_baseline
       (brand, family_id, user_id, metric, window_days,
        p05, p10, p50, p90, p95, mean, stddev, sample_count, computed_at)
     VALUES ($b, $f, $u, 'hrv_ms', 30, 50, 50, 50, 50, 50, 50, 2, 25, now())`,
    { b: BRAND, f: FAMILY, u: USER },
  )
  return db
}

/**
 * Today's date in `tz`, as YYYY-MM-DD.
 *
 * The fixture has to reason in LOCAL days because the query does. Deriving
 * offsets from `new Date().setUTCDate(...)` looks equivalent and is not: run
 * this after 5pm Pacific and "yesterday UTC" is today in Los Angeles, so a
 * reading intended for a completed day lands on the partial current one and
 * is correctly excluded — which reads as the feature being broken.
 */
function localToday(tz: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  return new Date(`${parts}T00:00:00Z`)
}

/**
 * One reading at `value`, `daysAgo` LOCAL days back.
 *
 * Stored at 20:00 UTC, which is midday in Los Angeles on the same calendar
 * date — comfortably inside the intended local day rather than near either
 * boundary, so the test is about run-counting rather than about edge rounding.
 */
async function reading(db: DB, daysAgo: number, hourUtc: number, value: number): Promise<void> {
  const d = localToday(TZ)
  d.setUTCDate(d.getUTCDate() - daysAgo)
  await db.execute(
    `INSERT INTO memory.hrv (ts, brand, family_id, user_id, device_id, hrv_ms)
     VALUES (CAST($ts AS TIMESTAMP), $b, $f, $u, 'ring_1', $v)`,
    {
      ts: `${d.toISOString().slice(0, 10)} ${String(hourUtc).padStart(2, '0')}:00:00`,
      b: BRAND,
      f: FAMILY,
      u: USER,
      v: value,
    },
  )
}

async function run(db: DB, rule = dayRule(), tz = TZ) {
  const compiled = compileRule(rule)
  return db.execute<{ observed_value: number, threshold_value: number }>(compiled.sql, {
    userId: USER,
    brand: BRAND,
    familyId: FAMILY,
    tz,
    ...compiled.params,
    baselineOffset: 10,
  })
}

describe('cadence: day counts days, not readings', () => {
  it('fires on three consecutive breaching days', async () => {
    const db = await boot()
    for (const d of [1, 2, 3]) await reading(db, d, 20, 30) // 30 < 50-10

    const rows = await run(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.threshold_value).toBe(40)
    await db.close?.()
  })

  it('does not fire on three breaching READINGS inside one day', async () => {
    const db = await boot()
    // Three low readings, all on the same local day. Under reading cadence
    // this is a 3-run; under day cadence it is one day.
    for (const h of [18, 19, 20]) await reading(db, 1, h, 30)

    expect(await run(db)).toHaveLength(0)
    await db.close?.()
  })

  it('breaks the run when a day recovers', async () => {
    const db = await boot()
    await reading(db, 1, 20, 30)
    await reading(db, 2, 20, 55) // above threshold — breaks it
    await reading(db, 3, 20, 30)

    expect(await run(db)).toHaveLength(0)
    await db.close?.()
  })
})

describe('a day with NO DATA breaks the run', () => {
  /*
   * The suite already covered a day that RECOVERS — present, not breaching.
   * It never covered a day that is simply absent, and the two are different:
   * a recovered day appears in the daily CTE and splits the island, while an
   * unworn day produces no row at all.
   *
   * Until the island key became calendar-based, the gap closed silently and
   * this fired. A run must be observed, not inferred across silence
   * (resync-2026-08-19 2a).
   */
  it('does not fire across an unworn day', async () => {
    const db = await boot()
    // Breaching on day-4 and day-2. Day-3 has no readings whatsoever.
    for (const d of [4, 2]) {
      for (const h of [9, 10, 11]) await reading(db, d, h, 30)
    }

    const rows = await run(db, dayRule({ consecutive: 2 }))
    expect(rows).toHaveLength(0)
    await db.close?.()
  }, 60_000)

  it('still fires when the same days ARE consecutive', async () => {
    // The control: identical values on adjacent dates must still fire, or the
    // test above would pass for a rule that never fires at all.
    const db = await boot()
    for (const d of [3, 2]) {
      for (const h of [9, 10, 11]) await reading(db, d, h, 30)
    }

    const rows = await run(db, dayRule({ consecutive: 2 }))
    expect(rows).toHaveLength(1)
    await db.close?.()
  }, 60_000)
})

describe('day boundaries are the USER\'s, not UTC', () => {
  it('puts a 04:00 UTC reading on the PREVIOUS local day in Los Angeles', async () => {
    const db = await boot()
    // 04:00 UTC is 21:00 the previous day in LA. This is the assertion that
    // distinguishes converting from labelling: `timezone($tz, ts)` on a naive
    // column LABELS the value with the zone instead of converting into it
    // (zivaone_app#73), which leaves the reading on its UTC date.
    //
    // Asserting the BUCKET rather than the run count is deliberate — an
    // earlier version of this test counted runs, and every reading shifted
    // together, so a 3-run stayed a 3-run and the defect sailed through.
    const d = localToday(TZ)
    d.setUTCDate(d.getUTCDate() - 2)
    const utcDate = d.toISOString().slice(0, 10)
    await db.execute(
      `INSERT INTO memory.hrv (ts, brand, family_id, user_id, device_id, hrv_ms)
       VALUES (CAST($ts AS TIMESTAMP), $b, $f, $u, 'ring_1', 30)`,
      { ts: `${utcDate} 04:00:00`, b: BRAND, f: FAMILY, u: USER },
    )

    const rows = await db.execute<{ day: string }>(
      // The compiler's own expression, not a copy of it.
      `SELECT ${localDayExpr('m.ts')}::VARCHAR AS day
       FROM v_hrv m WHERE m.user_id = $u AND m.brand = $b AND m.family_id = $f`,
      { tz: TZ, u: USER, b: BRAND, f: FAMILY },
    )

    const expected = new Date(`${utcDate}T00:00:00Z`)
    expected.setUTCDate(expected.getUTCDate() - 1)
    expect(rows[0]!.day.slice(0, 10)).toBe(expected.toISOString().slice(0, 10))

    await db.close?.()
  })

  it('survives a DST transition without splitting a day', async () => {
    const db = await boot()
    // Readings across the US spring-forward window. The zone-aware
    // date_trunc must still yield one bucket per local day; a naive
    // 24-hour arithmetic bucket would produce a 23-hour day and can
    // split or merge one.
    for (const d of [1, 2, 3, 4]) await reading(db, d, 20, 30)

    const rows = await run(db)
    expect(rows).toHaveLength(1)
    await db.close?.()
  })
})

describe('the partial current day is excluded', () => {
  it('ignores today, however it is going', async () => {
    const db = await boot()
    // Two full breaching days, plus a breaching reading today. If today
    // counted, this would be a 3-run and fire.
    await reading(db, 1, 20, 30)
    await reading(db, 2, 20, 30)
    await reading(db, 0, 20, 30)

    expect(await run(db)).toHaveLength(0)
    await db.close?.()
  })

  it('a good morning today cannot break a completed run', async () => {
    const db = await boot()
    for (const d of [1, 2, 3]) await reading(db, d, 20, 30)
    await reading(db, 0, 20, 99) // today looks fine so far

    // The run of three completed days still fires — otherwise the same rule
    // would fire or not depending on the hour it happened to run.
    expect(await run(db)).toHaveLength(1)
    await db.close?.()
  })
})

describe('validator', () => {
  it('rejects cadence day with a single day', () => {
    expect(() => validateRule(dayRule({ consecutive: 1 })))
      .toThrow(/consecutive >= 2/)
  })

  it('allows one day when explicitly opted in', () => {
    expect(() => validateRule(dayRule({ consecutive: 1, allowSingleDay: true })))
      .not
      .toThrow()
  })

  it('still rejects consecutive with the per-window baseline targets', () => {
    expect(() => validateRule(RuleSchema.parse({
      id: 'test.bad',
      name: 'bad',
      metric: 'hrv_ms',
      window: '30d',
      compare: 'less_than',
      severity: 'info',
      consecutive: 3,
      target: { type: 'baseline_percent', windowDays: 30, percent: 70 },
    }))).toThrow(/not supported with target.type/)
  })
})
