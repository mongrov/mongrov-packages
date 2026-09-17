import { describe, expect, it, vi } from 'vitest'
import { RuleSchema, RuleValidationError } from '../schema'
import { allowedWindowsFor, referencedCollectedOnlyColumns, validateRule } from '../validator'

function make(overrides: Record<string, unknown> = {}) {
  return RuleSchema.parse({
    id: 'test.rule',
    name: 'x',
    metric: 'hrv_ms',
    window: '24h',
    aggregation: 'avg',
    compare: 'less_than',
    severity: 'warn',
    target: { type: 'absolute', value: 40 },
    ...overrides,
  })
}

describe('validateRule — sampling minimums', () => {
  it('accepts a rule with a supported window', () => {
    expect(() => validateRule(make({ window: '24h' }))).not.toThrow()
  })

  it('rejects hrv_ms with 1h window (needs ≥ 24h)', () => {
    const rule = make({ window: '1h' })
    expect(() => validateRule(rule)).toThrow(RuleValidationError)
    try {
      validateRule(rule)
    }
    catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('hrv_ms')
      expect(msg).toContain('24h')
    }
  })

  it('rejects sleep_total_minutes with 1h window', () => {
    expect(() =>
      validateRule(
        make({
          metric: 'sleep_total_minutes',
          window: '1h',
          aggregation: 'sum',
          target: { type: 'absolute', value: 300 },
        }),
      )).toThrow(RuleValidationError)
  })

  it('accepts sleep_total_minutes with 3d window', () => {
    expect(() =>
      validateRule(
        make({
          metric: 'sleep_total_minutes',
          window: '3d',
          aggregation: 'sum',
          target: { type: 'absolute', value: 300 },
        }),
      )).not.toThrow()
  })

  it('allowedWindowsFor derives from sampling_minutes for non-explicit metrics', () => {
    // sleep_score is per_session → only 3d/7d/30d
    expect(allowedWindowsFor('sleep_score')).toEqual(['3d', '7d', '30d'])
    // calories has 10-minute sampling → all windows viable
    expect(allowedWindowsFor('calories')).toContain('1h')
  })
})

describe('validateRule — rawSql exposure', () => {
  it('rejects rawSql that references systolic_bp without override', () => {
    const rule = make({
      rawSql: 'SELECT AVG(systolic_bp) FROM hrv WHERE user_id = $userId',
    })
    expect(() => validateRule(rule)).toThrow(RuleValidationError)
  })

  it('warns via logger when rawSql + exposureOverride true', () => {
    const rule = make({
      rawSql: 'SELECT AVG(vascular_aging) FROM hrv WHERE user_id = $userId',
      exposureOverride: true,
    })
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    expect(() => validateRule(rule, logger)).not.toThrow()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('rawSql with no collected_only refs passes', () => {
    const rule = make({
      rawSql: 'SELECT AVG(hrv_ms) FROM hrv WHERE user_id = $userId',
    })
    expect(() => validateRule(rule)).not.toThrow()
  })
})

describe('referencedCollectedOnlyColumns', () => {
  it('detects systolic_bp / diastolic_bp / vascular_aging references', () => {
    expect(referencedCollectedOnlyColumns('SELECT systolic_bp FROM x')).toContain('systolic_bp')
    expect(referencedCollectedOnlyColumns('SELECT diastolic_bp FROM x')).toContain('diastolic_bp')
    expect(referencedCollectedOnlyColumns('SELECT vascular_aging FROM x')).toContain('vascular_aging')
  })

  it('ignores substrings (whole-word match)', () => {
    expect(referencedCollectedOnlyColumns('SELECT xxsystolic_bpp FROM x')).toEqual([])
  })
})

describe('validateRule — minDays (QA #108)', () => {
  const steps = (o: Record<string, unknown> = {}) => make({
    metric: 'activity_steps',
    window: '7d',
    aggregation: 'sum',
    target: { type: 'absolute', value: 20000 },
    ...o,
  })

  it('accepts a day floor inside a day-sized window', () => {
    expect(() => validateRule(steps({ minDays: 6 }))).not.toThrow()
  })

  it('rejects a floor larger than the window — it could never fire', () => {
    expect(() => validateRule(steps({ minDays: 8 }))).toThrow(/exceeds the 7d window/)
  })

  it('rejects an hour window, which holds no day count', () => {
    expect(() => validateRule(make({ window: '24h', minDays: 1 }))).toThrow(/window measured in days/)
  })

  it('rejects day cadence and consecutive runs — aggregates only', () => {
    expect(() => validateRule(make({ window: '7d', cadence: 'day', consecutive: 2, minDays: 3 })))
      .toThrow(/window aggregates only/)
    expect(() => validateRule(make({ window: '7d', consecutive: 3, minDays: 3 })))
      .toThrow(/window aggregates only/)
  })
})

describe('validateRule — day-cadence window must hold the run (zivaone_app#55)', () => {
  const temp = (o: Record<string, unknown> = {}) => make({
    metric: 'temp_c',
    aggregation: 'max',
    compare: 'greater_than',
    cadence: 'day',
    consecutive: 2,
    target: { type: 'absolute', value: 37.5 },
    ...o,
  })

  it('rejects the shipped temp-flag shape: a 2-day run in a 24h window', () => {
    // Today is excluded, so 24h held at most one partial completed day.
    expect(() => validateRule(temp({ window: '24h' }))).toThrow(/could never fire/)
  })

  it('needs the run plus today', () => {
    expect(() => validateRule(temp({ window: '3d', consecutive: 3 }))).toThrow(/at least 4 days/)
    expect(() => validateRule(temp({ window: '7d', consecutive: 3 }))).not.toThrow()
  })

  it('sizes a consecutiveKey by its registered range, not its compile-time default', () => {
    // user:tempNights ranges 1-5, so the window must hold a 5-night run.
    expect(() => validateRule(temp({ window: '3d', consecutiveKey: 'user:tempNights' })))
      .toThrow(/5-day run needs a window of at least 6 days/)
    expect(() => validateRule(temp({ window: '7d', consecutiveKey: 'user:tempNights' }))).not.toThrow()
  })
})
