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
