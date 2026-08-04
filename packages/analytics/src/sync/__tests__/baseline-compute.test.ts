/**
 * Sprint 5 T-13 / T-14 — day-first baseline compute.
 *
 * The correctness property is the *shape* of the query, so most of these
 * assert the SQL directly. The headline case is the Ziva #3 fixture: raw
 * quantiles and day-first quantiles must disagree, and day-first must win.
 */

import { describe, expect, it, vi } from 'vitest'

import { BASELINE_MIN_DAYS, getBaselineMetricIds } from '../../core/metric_metadata'
import { buildBaselineSql, createBaselineComputer } from '../baseline-compute'

import { createFakeEngine } from './__fakes__/fake-engine'

const CTX = {
  brand: 'ziva',
  familyId: 'fam1',
  userId: 'alice',
  userTimezone: 'America/Los_Angeles',
}

/** Engine stub returning a scripted aggregate row, then swallowing the UPSERT. */
function scriptedEngine(row: Record<string, unknown> | null) {
  const calls: { sql: string, params: Record<string, unknown> }[] = []
  const engine = {
    async execute(sql: string, params?: Record<string, unknown>) {
      calls.push({ sql, params: params ?? {} })
      if (sql.includes('quantile_cont')) return row ? [row] : []
      return []
    },
  }
  return { engine, calls }
}

describe('buildBaselineSql — day-first shape', () => {
  it('collapses to one value per local day BEFORE quantiling', () => {
    const sql = buildBaselineSql('spo2', 30)

    // The CTE is the whole point: quantiles run over `daily_values`, never
    // over raw readings.
    expect(sql).toContain('WITH daily_values AS')
    expect(sql).toContain(`date_trunc('day', timezone($tz, ts))`)
    expect(sql).toContain('avg(spo2) AS daily_value')
    expect(sql).toContain('GROUP BY day')
    expect(sql).toContain('quantile_cont(daily_value, 0.10)')
    expect(sql).toContain('FROM daily_values')
    // A raw-quantile implementation would read the column directly.
    expect(sql).not.toContain('quantile_cont(spo2')
  })

  it('reads the union view, not a raw catalog table', () => {
    // principle 19 — freshness comes from v_{table}.
    expect(buildBaselineSql('spo2', 30)).toContain('FROM v_spo2')
    expect(buildBaselineSql('hrv_ms', 7)).toContain('FROM v_hrv')
    expect(buildBaselineSql('spo2', 30)).not.toContain('r2.default')
  })

  it('dispatches the daily collapse on baselineDailyAggregate', () => {
    // avg for point-in-time metrics...
    expect(buildBaselineSql('hrv_ms', 30)).toContain('avg(hrv_ms) AS daily_value')
    expect(buildBaselineSql('hr_bpm', 30)).toContain('avg(bpm) AS daily_value')
    // ...sum for counters — a day's steps is the total, not the mean.
    expect(buildBaselineSql('activity_steps', 30)).toContain('sum(steps) AS daily_value')
  })

  it('keys sleep on night_of rather than re-deriving a day', () => {
    const sql = buildBaselineSql('sleep_total_minutes', 30)
    // night_of is already the mapper's DST-correct 6pm-6pm attribution.
    expect(sql).toContain('night_of AS day')
    expect(sql).toContain('GROUP BY night_of')
    expect(sql).toContain('sum(total_minutes) AS daily_value')
    expect(sql).toContain('ts_start >')
    // And it still groups — see the next test for why that matters.
    expect(sql).toContain('WITH daily_values AS')
  })

  it('enforces the day minimum in SQL, counting rows of daily_values', () => {
    const sql = buildBaselineSql('spo2', 30)
    expect(sql).toContain(`HAVING count(*) >= ${BASELINE_MIN_DAYS}`)
    expect(BASELINE_MIN_DAYS).toBe(20)
  })

  it('binds the window rather than concatenating it into an INTERVAL', () => {
    const sql = buildBaselineSql('spo2', 90)
    expect(sql).toContain('(INTERVAL 1 DAY) * $windowDays')
    expect(sql).not.toContain('INTERVAL 90')
  })

  it('binds tenant params, never inlines them', () => {
    const sql = buildBaselineSql('spo2', 30)
    expect(sql).toContain('user_id = $userId')
    expect(sql).toContain('brand = $brand')
    expect(sql).toContain('family_id = $familyId')
  })

  it('builds for every baseline metric without throwing', () => {
    for (const metric of getBaselineMetricIds()) {
      for (const window of [7, 30, 90] as const) {
        expect(() => buildBaselineSql(metric, window)).not.toThrow()
      }
    }
  })
})

describe('Ziva #3 — day-first vs raw quantiles diverge', () => {
  it('a daily intra-day dip must not become the bottom of the usual range', () => {
    // Fixture: each day reads 95, 95, 87, 95, 95 → daily avg 93.4.
    // Raw p10 across 30 days of those readings lands on the 87 dip.
    // Day-first p10 lands on 93.4, because every DAY is 93.4.
    const perDay = [95, 95, 87, 95, 95]
    const days = 30

    const raw = perDay.flatMap(v => Array.from({ length: days }, () => v))
      .sort((a, b) => a - b)
    const rawP10 = raw[Math.floor(0.1 * (raw.length - 1))]

    const dailyValues = Array.from({ length: days }, () =>
      perDay.reduce((a, v) => a + v, 0) / perDay.length)
    const dayFirstP10 = dailyValues[Math.floor(0.1 * (dailyValues.length - 1))]

    expect(rawP10).toBe(87) // the dip — wrong
    expect(dayFirstP10).toBeCloseTo(93.4, 5) // day-to-day variation — right
    expect(dayFirstP10).not.toBe(rawP10)

    // And the generated SQL is the day-first one.
    expect(buildBaselineSql('spo2', 30)).toContain('quantile_cont(daily_value, 0.10)')
  })
})

describe('computeOne', () => {
  const fullRow = {
    p05: 92, p10: 93, p50: 96, p90: 98, p95: 99,
    mean: 96, stddev: 1.5, sample_count: 28,
  }

  it('UPSERTs and emits user_baseline:updated when there is enough data', async () => {
    const emitted: { name: string, payload: unknown }[] = []
    const { engine, calls } = scriptedEngine(fullRow)
    const computer = createBaselineComputer({
      analytics: engine as never,
      eventBus: { emit: (name: string, payload: unknown) => emitted.push({ name, payload }) } as never,
    })

    expect(await computer.computeOne('spo2', 30, CTX)).toBe(true)

    const upsert = calls.find(c => c.sql.includes('INSERT INTO user_baseline'))
    expect(upsert).toBeDefined()
    expect(upsert!.sql).toContain('ON CONFLICT')
    expect(upsert!.params).toMatchObject({
      brand: 'ziva', familyId: 'fam1', userId: 'alice',
      metric: 'spo2', windowDays: 30, p10: 93, sampleCount: 28,
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0].name).toBe('user_baseline:updated')
    expect(emitted[0].payload).toMatchObject({
      userId: 'alice', metric: 'spo2', windowDays: 30, sampleCount: 28,
    })
  })

  it('passes the user timezone through — day buckets are local', async () => {
    const { engine, calls } = scriptedEngine(fullRow)
    const computer = createBaselineComputer({ analytics: engine as never })
    await computer.computeOne('spo2', 30, CTX)

    expect(calls[0].params.tz).toBe('America/Los_Angeles')
  })

  it('writes nothing when HAVING filtered the row out', async () => {
    const { engine, calls } = scriptedEngine(null)
    const computer = createBaselineComputer({ analytics: engine as never })

    expect(await computer.computeOne('spo2', 30, CTX)).toBe(false)
    expect(calls.some(c => c.sql.includes('INSERT INTO user_baseline'))).toBe(false)
  })

  it('refuses a row that reports fewer than 20 days, belt-and-braces', async () => {
    // 15 days of 30-min sampling is 720 readings but only 15 days. If the
    // HAVING ever regressed, this second check still declines to write.
    const { engine, calls } = scriptedEngine({ ...fullRow, sample_count: 15 })
    const computer = createBaselineComputer({ analytics: engine as never })

    expect(await computer.computeOne('spo2', 30, CTX)).toBe(false)
    expect(calls.some(c => c.sql.includes('INSERT INTO user_baseline'))).toBe(false)
  })

  it('emits nothing when no row was written', async () => {
    const emitted: string[] = []
    const { engine } = scriptedEngine(null)
    const computer = createBaselineComputer({
      analytics: engine as never,
      eventBus: { emit: (n: string) => emitted.push(n) } as never,
    })
    await computer.computeOne('spo2', 30, CTX)
    expect(emitted).toEqual([])
  })
})

describe('computeAll', () => {
  it('covers every metric x window and reports the tally', async () => {
    const { engine } = scriptedEngine({
      p05: 1, p10: 2, p50: 3, p90: 4, p95: 5,
      mean: 3, stddev: 1, sample_count: 25,
    })
    const computer = createBaselineComputer({ analytics: engine as never })

    const result = await computer.computeAll(CTX)

    // 7 metrics x 3 windows = the 21 baselines the design calls for.
    expect(getBaselineMetricIds()).toHaveLength(7)
    expect(result.computed).toBe(21)
    expect(result.skipped).toBe(0)
    expect(result.failed).toBe(0)
  })

  it('isolates a per-metric failure from the other twenty', async () => {
    let calls = 0
    const engine = {
      async execute(sql: string) {
        if (sql.includes('quantile_cont')) {
          calls += 1
          if (calls === 1) throw new Error('view v_hrv does not exist')
          return [{
            p05: 1, p10: 2, p50: 3, p90: 4, p95: 5,
            mean: 3, stddev: 1, sample_count: 25,
          }]
        }
        return []
      },
    }
    const warn = vi.fn()
    const computer = createBaselineComputer({
      analytics: engine as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn },
    })

    const result = await computer.computeAll(CTX)
    expect(result.failed).toBe(1)
    expect(result.computed).toBe(20)
    expect(warn).toHaveBeenCalled()
  })

  it('honours metric + window overrides', async () => {
    const { engine } = scriptedEngine(null)
    const computer = createBaselineComputer({
      analytics: engine as never,
      metrics: ['spo2'],
      windows: [30],
    })
    const result = await computer.computeAll(CTX)
    expect(result.skipped).toBe(1)
    expect(result.computed).toBe(0)
  })
})
