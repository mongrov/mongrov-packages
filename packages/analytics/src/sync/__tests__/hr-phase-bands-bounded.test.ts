/*
 * Which form of the HR phase-band query `baseline-compute` runs, and what
 * happens when the bounded one throws (mongrov-packages#44). The two forms
 * return the same rails: `bounded-readers-bands-tools.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { createBaselineComputer } from '../baseline-compute'

const CTX = { brand: 'ziva', familyId: 'fam1', userId: 'alice', userTimezone: 'UTC' }
const RAIL = { p05: 50, p10: 51, p50: 55, p90: 60, p95: 61, mean: 55, stddev: 2, sample_count: 25 }

function engine(opts: { boundedReads?: boolean, failBounded?: boolean }) {
  const calls: string[] = []
  return {
    calls,
    analytics: {
      boundedReads: opts.boundedReads,
      async execute(sql: string) {
        calls.push(sql)
        if (opts.failBounded && sql.includes('_between('))
          throw new Error('Binder Error: native only')
        return sql.includes(`'hr_' || phase`) ? [{ metric: 'hr_asleep_lo', ...RAIL }] : []
      },
    },
  }
}

const phaseSql = (calls: string[]) => calls.filter(s => s.includes(`'hr_' || phase`))

describe('computeHrPhaseBands — bounded reads', () => {
  it('runs the bounded form when the engine has every macro', async () => {
    const { analytics, calls } = engine({ boundedReads: true })
    expect(await createBaselineComputer({ analytics: analytics as never }).computeHrPhaseBands(30, CTX)).toBe(1)
    const [sql] = phaseSql(calls)
    expect(sql).toContain('v_heart_rate_clean_between(')
    expect(sql).toContain('v_motion_between(')
  })

  it('runs the view form otherwise, including an engine that does not say', async () => {
    for (const boundedReads of [false, undefined]) {
      const { analytics, calls } = engine({ boundedReads })
      await createBaselineComputer({ analytics: analytics as never }).computeHrPhaseBands(30, CTX)
      expect(phaseSql(calls).some(s => s.includes('_between('))).toBe(false)
    }
  })

  it('a throwing bounded form is retried as the view form; the rails are still written', async () => {
    const { analytics, calls } = engine({ boundedReads: true, failBounded: true })
    const warns: { message: string, meta?: Record<string, unknown> }[] = []
    const computer = createBaselineComputer({
      analytics: analytics as never,
      logger: { debug() {}, info() {}, warn: (message: string, meta?: Record<string, unknown>) => warns.push({ message, meta }), error() {} } as never,
    })
    expect(await computer.computeHrPhaseBands(30, CTX)).toBe(1)
    expect(phaseSql(calls).map(s => s.includes('_between('))).toEqual([true, false])
    expect(calls).toContain('SELECT 1')
    expect(calls.some(s => s.includes('INSERT INTO user_baseline'))).toBe(true)
    expect(warns.find(w => w.message === 'baseline.bounded_failed')?.meta).toMatchObject({ windowDays: 30 })
  })
})
