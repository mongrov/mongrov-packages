/**
 * `baseline_offset` target (sprint6 T-03).
 *
 * Executed against real DuckDB rather than snapshotted, because the thing
 * that matters is which baseline it reads. `baseline_percent` and
 * `baseline_stddev` recompute a mean inline over raw readings; this target
 * reads the STORED `user_baseline.p50`, which is day-first and ≥20-day gated
 * (principle 27). A snapshot of the SQL string would pass either way.
 */
import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../core/schemas'
import { BASELINE_OFFSET_PARAM, compileRule } from '../compiler'
import { RuleSchema } from '../schema'

const BRAND = 'ziva'
const FAMILY = 'fam_1'
const USER = 'alice'

type DB = Awaited<ReturnType<typeof createRealDuckDB>>

function rule(overrides: Record<string, unknown> = {}) {
  return RuleSchema.parse({
    id: 'test.hrv-below-usual',
    name: 'HRV below usual',
    metric: 'hrv_ms',
    window: '24h',
    aggregation: 'avg',
    compare: 'less_than',
    severity: 'info',
    target: { type: 'baseline_offset', windowDays: 30, offset: 10, direction: 'below' },
    ...overrides,
  })
}

async function boot(): Promise<DB> {
  const db = await createRealDuckDB(['icu'])
  for (const t of ['hrv', 'user_baseline'] as const) {
    await db.execute(LOCAL_SCHEMAS[t].replace(`CREATE TABLE ${t}`, `CREATE TABLE memory.${t}`))
  }
  await db.execute(
    generateViewDdl('hrv', { brand: BRAND, familyId: FAMILY, localCatalog: 'memory' }),
  )
  return db
}

/** `n` readings at `value`, spread over the last few hours. */
async function seedHrv(db: DB, value: number, n = 4): Promise<void> {
  for (let i = 0; i < n; i++) {
    await db.execute(
      `INSERT INTO memory.hrv (ts, brand, family_id, user_id, device_id, hrv_ms)
       VALUES (now() - INTERVAL (CAST($h AS BIGINT)) HOUR, $b, $f, $u, 'ring_1', $v)`,
      { h: i + 1, b: BRAND, f: FAMILY, u: USER, v: value },
    )
  }
}

async function seedBaseline(db: DB, p50: number): Promise<void> {
  await db.execute(
    `INSERT INTO memory.user_baseline
       (brand, family_id, user_id, metric, window_days,
        p05, p10, p50, p90, p95, mean, stddev, sample_count, computed_at)
     VALUES ($b, $f, $u, 'hrv_ms', 30, $p50, $p50, $p50, $p50, $p50, $p50, 2, 25, now())`,
    { b: BRAND, f: FAMILY, u: USER, p50 },
  )
}

async function run(db: DB, compiled: ReturnType<typeof compileRule>, extra: Record<string, unknown> = {}) {
  return db.execute<{ observed_value: number, threshold_value: number }>(compiled.sql, {
    userId: USER,
    brand: BRAND,
    familyId: FAMILY,
    ...compiled.params,
    ...extra,
  })
}

describe('baseline_offset fires against the stored baseline', () => {
  it('fires when the observed average sits offset below p50', async () => {
    const db = await boot()
    await seedBaseline(db, 50)
    await seedHrv(db, 35) // 15 below p50, offset is 10

    const rows = await run(db, compileRule(rule()), { baselineOffset: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.threshold_value).toBe(40) // 50 - 10

    await db.close?.()
  })

  it('does not fire inside the offset', async () => {
    const db = await boot()
    await seedBaseline(db, 50)
    await seedHrv(db, 45) // only 5 below p50

    expect(await run(db, compileRule(rule()), { baselineOffset: 10 })).toHaveLength(0)
    await db.close?.()
  })

  it('inverts cleanly for direction: above', async () => {
    const db = await boot()
    await seedBaseline(db, 50)
    await seedHrv(db, 65)

    const above = rule({
      target: { type: 'baseline_offset', windowDays: 30, offset: 10, direction: 'above' },
    })
    const rows = await run(db, compileRule(above), { baselineOffset: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.threshold_value).toBe(60) // 50 + 10

    await db.close?.()
  })

  it('yields nothing when no baseline row exists — the 20-day gate', async () => {
    const db = await boot()
    await seedHrv(db, 5) // far below anything, but there is no baseline
    // The subquery returns NULL, the comparison is NULL, HAVING drops it.
    // Silence is correct: "below usual" is meaningless before a usual exists.
    expect(await run(db, compileRule(rule()), { baselineOffset: 10 })).toHaveLength(0)
    await db.close?.()
  })

  it('reads the requested window, not whatever baseline row exists', async () => {
    const db = await boot()
    await seedBaseline(db, 50) // window_days = 30
    await seedHrv(db, 20)

    const sevenDay = rule({
      target: { type: 'baseline_offset', windowDays: 7, offset: 10, direction: 'below' },
    })
    // No 7-day row, so no threshold, so no violation — even though the
    // 30-day row would have fired. A rule asking for 7d must not silently
    // borrow the 30d band.
    expect(await run(db, compileRule(sevenDay), { baselineOffset: 10 })).toHaveLength(0)

    await db.close?.()
  })
})

describe('baseline_offset compilation', () => {
  it('binds the offset rather than inlining it, so KVStore can override', () => {
    const compiled = compileRule(rule({
      target: {
        type: 'baseline_offset',
        windowDays: 30,
        offset: 10,
        direction: 'below',
        offsetKey: 'user:hrvDropMs',
      },
    }))

    expect(compiled.offsetKey).toBe('user:hrvDropMs')
    expect(compiled.offsetDefault).toBe(10)
    // With a key, the compiler leaves the value to the evaluator entirely.
    expect(compiled.params).not.toHaveProperty(BASELINE_OFFSET_PARAM)
    expect(compiled.sql).toContain(`$${BASELINE_OFFSET_PARAM}`)
  })

  it('supplies the literal offset when no key is configured', () => {
    const compiled = compileRule(rule())
    expect(compiled.offsetKey).toBeUndefined()
    expect(compiled.params[BASELINE_OFFSET_PARAM]).toBe(10)
  })

  it('casts every parameter — the react-native-duckdb prepare path', () => {
    // zivaone_app#70/#72: a bare param in a projection or arithmetic
    // expression has no type context at prepare time and throws
    // ParameterNotResolvedException on device. New SQL must not reintroduce
    // it, whatever the older branches still do.
    const sql = compileRule(rule()).sql
    for (const p of ['baselineOffset', 'baselineDays', 'baselineMetric'])
      expect(sql).toMatch(new RegExp(`CAST\\(\\$${p}\\s+AS\\s+\\w+\\)`))
  })

  it('reads the stored baseline table, not a recomputed mean', () => {
    const sql = compileRule(rule()).sql
    expect(sql).toContain('FROM user_baseline')
    expect(sql).toContain('p50')
    // The inline-mean shape the other baseline targets use.
    expect(sql).not.toContain('AVG(m.hrv_ms) AS mean')
  })
})
