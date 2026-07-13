import { describe, expect, it } from 'vitest'
import { RuleSchema, RuleValidationError } from '../schema'

describe('RuleSchema', () => {
  const baseRule = {
    id: 'test.rule',
    name: 'Test rule',
    metric: 'hrv_ms',
    window: '24h',
    aggregation: 'avg',
    compare: 'less_than',
    severity: 'warn',
    target: { type: 'absolute', value: 40 },
  }

  it('parses a minimal valid rule + fills defaults', () => {
    const parsed = RuleSchema.parse(baseRule)
    expect(parsed.id).toBe('test.rule')
    expect(parsed.throttle.minGapMinutes).toBe(60)
    expect(parsed.throttle.maxPerDay).toBe(3)
    expect(parsed.aggregation).toBe('avg')
  })

  it('rejects unknown metric', () => {
    expect(() =>
      RuleSchema.parse({ ...baseRule, metric: 'nonexistent' }),
    ).toThrow()
  })

  it('rejects collected_only metrics from the enum', () => {
    expect(() =>
      RuleSchema.parse({ ...baseRule, metric: 'systolic_bp' }),
    ).toThrow()
    expect(() =>
      RuleSchema.parse({ ...baseRule, metric: 'vascular_aging' }),
    ).toThrow()
  })

  it('rejects unknown window / compare / severity', () => {
    expect(() => RuleSchema.parse({ ...baseRule, window: '2h' })).toThrow()
    expect(() => RuleSchema.parse({ ...baseRule, compare: 'roughly' })).toThrow()
    expect(() => RuleSchema.parse({ ...baseRule, severity: 'fatal' })).toThrow()
  })

  it('accepts each valid target discriminant', () => {
    for (const target of [
      { type: 'absolute', value: 40 },
      { type: 'baseline_percent', windowDays: 7, percent: 70 },
      { type: 'baseline_stddev', windowDays: 14, stddevs: 1.5 },
      { type: 'range', min: 40, max: 90 },
    ]) {
      expect(() => RuleSchema.parse({ ...baseRule, target })).not.toThrow()
    }
  })

  it('rejects invalid discriminant', () => {
    expect(() =>
      RuleSchema.parse({ ...baseRule, target: { type: 'ratio', value: 0.7 } }),
    ).toThrow()
  })

  it('RuleValidationError.name is set', () => {
    const err = new RuleValidationError('nope')
    expect(err.name).toBe('RuleValidationError')
    expect(err.message).toBe('nope')
  })
})
