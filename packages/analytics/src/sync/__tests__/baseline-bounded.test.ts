/*
 * Which form of a per-metric baseline query `computeOne` runs, and what
 * happens when the bounded one throws (mongrov-packages#44). The two forms
 * return the same row: `bounded-readers-baselines.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { baselineHasBoundedForm, buildBaselineSql, createBaselineComputer } from '../baseline-compute'

const CTX = { brand: 'ziva', familyId: 'fam1', userId: 'alice', userTimezone: 'UTC' }
const ROW = { p05: 50, p10: 51, p50: 55, p90: 60, p95: 61, mean: 55, stddev: 2, sample_count: 25 }

function engine(opts: { boundedReads?: boolean, failBounded?: boolean }) {
  const calls: string[] = []
  let reported = 0
  return {
    calls,
    reported: () => reported,
    analytics: {
      boundedReads: opts.boundedReads,
      reportBoundedReadFailure: () => {
        reported += 1
      },
      async execute(sql: string) {
        calls.push(sql)
        if (opts.failBounded && sql.includes('_between('))
          throw new Error('Binder Error: native only')
        return sql.includes('quantile_cont') ? [ROW] : []
      },
    },
  }
}

const baselineSql = (calls: string[]) => calls.filter(s => s.includes('quantile_cont'))

/** `v_x_clean_between(<args>)` → `v_x_clean`, args matched by balanced parentheses. */
function stripMacroCalls(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const at = sql.indexOf('_between(', i)
    if (at < 0)
      return out + sql.slice(i)
    out += sql.slice(i, at)
    let depth = 0
    let j = at + '_between'.length
    do {
      if (sql[j] === '(')
        depth += 1
      else if (sql[j] === ')')
        depth -= 1
      j += 1
    } while (depth > 0 && j < sql.length)
    i = j
  }
  return out
}

describe('computeOne — bounded reads', () => {
  it('reads the clean view\'s macro when the engine has every macro', async () => {
    const { analytics, calls } = engine({ boundedReads: true })
    expect(await createBaselineComputer({ analytics: analytics as never }).computeOne('spo2', 30, CTX)).toBe(true)
    expect(baselineSql(calls)[0]).toContain('v_spo2_clean_between(')
  })

  it('reads the view otherwise, including an engine that does not say', async () => {
    for (const boundedReads of [false, undefined]) {
      const { analytics, calls } = engine({ boundedReads })
      await createBaselineComputer({ analytics: analytics as never }).computeOne('spo2', 30, CTX)
      expect(baselineSql(calls).some(s => s.includes('_between('))).toBe(false)
    }
  })

  it('a throwing bounded form is retried as the view form; the row is still written and the failure reported', async () => {
    const { analytics, calls, reported } = engine({ boundedReads: true, failBounded: true })
    const warns: { message: string, meta?: Record<string, unknown> }[] = []
    const computer = createBaselineComputer({
      analytics: analytics as never,
      logger: { debug() {}, info() {}, warn: (message: string, meta?: Record<string, unknown>) => warns.push({ message, meta }), error() {} } as never,
    })
    expect(await computer.computeOne('hr_bpm', 7, CTX)).toBe(true)
    expect(baselineSql(calls).map(s => s.includes('_between('))).toEqual([true, false])
    expect(calls).toContain('SELECT 1')
    expect(calls.some(s => s.includes('INSERT INTO user_baseline'))).toBe(true)
    expect(reported()).toBe(1)
    expect(warns.find(w => w.message === 'baseline.bounded_failed')?.meta).toMatchObject({ metric: 'hr_bpm', windowDays: 7 })
  })

  it('steps and sleep have no bounded form and never name a macro', async () => {
    expect(baselineHasBoundedForm('activity_steps')).toBe(false)
    expect(baselineHasBoundedForm('sleep_total_minutes')).toBe(false)
    for (const metric of ['activity_steps', 'sleep_total_minutes'] as const) {
      expect(buildBaselineSql(metric, 30, { bounded: true })).toBe(buildBaselineSql(metric, 30))
      const { analytics, calls } = engine({ boundedReads: true })
      await createBaselineComputer({ analytics: analytics as never }).computeOne(metric, 30, CTX)
      expect(baselineSql(calls).some(s => s.includes('_between('))).toBe(false)
    }
  })

  it('the bounded forms differ from the view forms only in the relation', () => {
    for (const metric of ['hr_bpm', 'resting_hr', 'resting_gated_avg', 'spo2', 'temp_c', 'hrv_ms', 'stress'] as const) {
      const view = buildBaselineSql(metric, 30)
      const bounded = buildBaselineSql(metric, 30, { bounded: true })
      expect(bounded).not.toBe(view)
      expect(stripMacroCalls(bounded)).toBe(view)
    }
  })
})
