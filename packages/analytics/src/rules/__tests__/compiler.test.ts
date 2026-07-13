import { describe, expect, it } from 'vitest'
import { compileRule, sanitizeIdent } from '../compiler'
import { RuleSchema, RuleValidationError } from '../schema'

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

describe('sanitizeIdent', () => {
  it('replaces every non-alnum-underscore with _', () => {
    expect(sanitizeIdent('foo-bar')).toBe('foo_bar')
    expect(sanitizeIdent('drop table x;')).toBe('drop_table_x_')
    expect(sanitizeIdent('safe_id')).toBe('safe_id')
  })
})

describe('compileRule — absolute target', () => {
  it('produces parameterized SQL for HRV < 40', () => {
    const compiled = compileRule(make())
    expect(compiled.sql).toContain('$threshold_absolute')
    expect(compiled.sql).toContain('$userId')
    expect(compiled.sql).toContain('$brand')
    expect(compiled.sql).toContain('$familyId')
    expect(compiled.sql).toContain('AVG(hrv_ms)')
    expect(compiled.sql).toContain('FROM hrv')
    expect(compiled.sql).toContain(`INTERVAL '24 hours'`)
    expect(compiled.params.threshold_absolute).toBe(40)
  })

  it('greater_than emits > operator', () => {
    const compiled = compileRule(make({ compare: 'greater_than' }))
    expect(compiled.sql).toMatch(/observed_value > \$threshold_absolute/)
  })
})

describe('compileRule — baseline_percent', () => {
  it('emits baseline CTE + threshold multiplication', () => {
    const compiled = compileRule(
      make({ target: { type: 'baseline_percent', windowDays: 7, percent: 70 } }),
    )
    expect(compiled.sql).toContain('WITH baseline AS')
    expect(compiled.sql).toContain('AVG(hrv_ms)')
    expect(compiled.sql).toContain('$pct / 100.0')
    expect(compiled.sql).toContain('(INTERVAL 1 DAY) * $baselineDays')
    expect(compiled.params.baselineDays).toBe(7)
    expect(compiled.params.pct).toBe(70)
  })
})

describe('compileRule — baseline_stddev', () => {
  it('emits mean + stddev CTE', () => {
    const compiled = compileRule(
      make({ target: { type: 'baseline_stddev', windowDays: 14, stddevs: 1.5 } }),
    )
    expect(compiled.sql).toContain('stddev_pop')
    expect(compiled.sql).toContain('mean + $stddevs * sd')
    expect(compiled.params.stddevs).toBe(1.5)
  })
})

describe('compileRule — range', () => {
  it('between compare emits NOT BETWEEN', () => {
    const compiled = compileRule(
      make({ compare: 'between', target: { type: 'range', min: 40, max: 90 } }),
    )
    expect(compiled.sql).toContain('NOT (observed_value BETWEEN $range_min AND $range_max)')
    expect(compiled.params.range_min).toBe(40)
    expect(compiled.params.range_max).toBe(90)
  })
})

describe('compileRule — sleep_session uses ts_start', () => {
  it('emits ts_start as the time column', () => {
    const compiled = compileRule(
      make({
        metric: 'sleep_total_minutes',
        window: '3d',
        aggregation: 'sum',
        target: { type: 'absolute', value: 300 },
      }),
    )
    expect(compiled.sql).toContain('ts_start >')
    expect(compiled.sql).toContain('FROM sleep_session')
  })
})

describe('compileRule — rawSql pass-through', () => {
  it('returns rawSql verbatim when placeholders are runtime-bound only', () => {
    const rule = make({
      rawSql: `SELECT AVG(hrv_ms) AS observed_value, 40 AS threshold_value FROM hrv WHERE user_id = $userId AND brand = $brand AND family_id = $familyId HAVING observed_value < 40`,
    })
    const compiled = compileRule(rule)
    expect(compiled.sql).toContain('SELECT AVG(hrv_ms)')
    expect(compiled.params).toEqual({})
  })

  it('rejects rawSql with undeclared placeholder', () => {
    const rule = make({
      rawSql: 'SELECT $badParam FROM hrv WHERE user_id = $userId',
    })
    expect(() => compileRule(rule)).toThrow(RuleValidationError)
  })

  it('accepts declared rawSqlParams', () => {
    const rule = make({
      rawSql: 'SELECT AVG(hrv_ms) FROM hrv WHERE user_id = $userId AND hrv_ms > $threshold',
      rawSqlParams: ['threshold'],
    })
    expect(() => compileRule(rule)).not.toThrow()
  })
})
