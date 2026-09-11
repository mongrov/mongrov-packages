/**
 * Every bound param in compiled rule SQL is CAST at its use (zivaone_app#70).
 *
 * react-native-duckdb prepares with no values and binds afterwards, so a param
 * whose type cannot be resolved from SQL context throws
 * ParameterNotResolvedException on device — and poisons the shared
 * connection, failing the next unrelated query too. Stock DuckDB, which this
 * suite runs on, supplies values to the binder and does NOT reproduce it. So
 * the guard is structural: over every target type and both cadences, each
 * `$name` must sit directly inside `CAST(`, except the tenant triple, which
 * compares to VARCHAR columns and resolves.
 */
import { describe, expect, it } from 'vitest'

import { compileRule } from '../compiler'
import { RuleSchema } from '../schema'

const TENANT = new Set(['userId', 'brand', 'familyId'])

function rule(overrides: Record<string, unknown>) {
  return RuleSchema.parse({
    id: 'test.casts',
    name: 'casts',
    metric: 'hrv_ms',
    window: '24h',
    aggregation: 'avg',
    compare: 'less_than',
    severity: 'warn',
    target: { type: 'absolute', value: 40 },
    ...overrides,
  })
}

const USER_SETTING = { type: 'user_setting', key: 'user:spo2SafeLevel', defaultValue: 90 }

const CASES: [string, Record<string, unknown>][] = [
  ['absolute', {}],
  ['user_setting', { metric: 'spo2', target: USER_SETTING }],
  ['range · between', { compare: 'between', target: { type: 'range', min: 40, max: 90 } }],
  ['range · less_than', { target: { type: 'range', min: 40, max: 90 } }],
  ['baseline_percent', { target: { type: 'baseline_percent', windowDays: 7, percent: 70 } }],
  ['baseline_stddev', { target: { type: 'baseline_stddev', windowDays: 14, stddevs: 1.5 } }],
  ['baseline_offset', { target: { type: 'baseline_offset', windowDays: 30, offset: 10, direction: 'below' } }],
  ['consecutive · absolute', { consecutive: 3 }],
  ['consecutive · user_setting', { metric: 'spo2', consecutive: 3, target: USER_SETTING }],
  ['consecutive · range', { consecutive: 3, compare: 'between', target: { type: 'range', min: 40, max: 90 } }],
  ['day cadence · absolute', { window: '30d', cadence: 'day', consecutive: 3 }],
  ['day cadence · baseline_offset', {
    window: '30d',
    cadence: 'day',
    consecutive: 3,
    target: { type: 'baseline_offset', windowDays: 30, offset: 10, direction: 'below' },
  }],
]

/** Every `$name` in `sql` that is not the first thing inside a `CAST(`. */
function uncastParams(sql: string): string[] {
  const bare: string[] = []
  for (const m of sql.matchAll(/\$([a-z]\w*)/gi)) {
    const name = m[1]
    if (TENANT.has(name))
      continue
    if (!sql.slice(0, m.index).endsWith('CAST('))
      bare.push(name)
  }
  return bare
}

describe('compiled rule SQL casts every bound param', () => {
  it.each(CASES)('%s', (_label, overrides) => {
    const { sql } = compileRule(rule(overrides))
    expect(sql).toMatch(/\$[a-z]/i) // the case binds something, or it proves nothing
    expect(uncastParams(sql)).toEqual([])
  })

  it('the detector itself flags a bare param', () => {
    expect(uncastParams('SELECT $threshold_absolute AS t WHERE user_id = $userId')).toEqual(['threshold_absolute'])
    expect(uncastParams('SELECT CAST($threshold_absolute AS DOUBLE) AS t')).toEqual([])
  })
})
