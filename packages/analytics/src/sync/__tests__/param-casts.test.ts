/**
 * Guards the untyped-bound-parameter class (zivaone_app#70, #72).
 *
 * react-native-duckdb prepares a statement with NO values and executes with
 * them, so a parameter's type must resolve from SQL context at prepare time.
 * Where there is none it stays UNKNOWN and the bind throws
 * `ParameterNotResolvedException` — which is not in DuckDB's
 * transaction-exempt set, so it also invalidates the shared connection and
 * unrelated queries fail afterwards with `TransactionException`.
 *
 * The reason this is a SHAPE test rather than an execution test is the whole
 * point: node/Python DuckDB hand values to the binder, so the type always
 * resolves and a local harness reports every one of these as passing. Running
 * the SQL here would prove nothing. Only the device shows the failure, so the
 * only thing worth asserting off-device is the shape of the generated string.
 *
 * Scope: `buildBaselineSql` plus the inline SQL in `tools/impls`. The rules
 * compiler is the same defect and is fixed separately (#70); when that lands,
 * fold `compileRule` output into `assertParamsAreTyped` below rather than
 * writing a third copy of this.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { BASELINE_WINDOW_DAYS, getBaselineMetricIds } from '../../core/metric_metadata'
import { buildBaselineSql } from '../baseline-compute'

/**
 * Params that carry their own context and must NOT be cast.
 *
 * Each is compared against a VARCHAR column, so DuckDB resolves the type from
 * the comparison. Casting them would be harmless but noisy, and the point of
 * the allowlist is that it is short and justified rather than "whatever
 * currently exists".
 */
const SELF_TYPING_PARAMS = new Set(['userId', 'brand', 'familyId', 'metric'])

/** Every `$name` in `sql` that is not immediately inside a `CAST(...)`. */
function untypedParams(sql: string): string[] {
  const cast = new Set<string>()
  for (const m of sql.matchAll(/CAST\(\s*\$([a-z_]\w*)\s+AS\s+\w+\s*\)/gi))
    cast.add(m[1])

  const seen = new Set<string>()
  for (const m of sql.matchAll(/\$([a-z_]\w*)/gi)) {
    const name = m[1]
    if (cast.has(name) || SELF_TYPING_PARAMS.has(name))
      continue
    seen.add(name)
  }
  return [...seen]
}

describe('generated SQL binds no untyped parameters', () => {
  const metrics = getBaselineMetricIds()

  it('covers every baseline metric — guard is not vacuous', () => {
    expect(metrics.length).toBeGreaterThan(0)
    expect(BASELINE_WINDOW_DAYS.length).toBeGreaterThan(0)
  })

  for (const metric of metrics) {
    for (const days of BASELINE_WINDOW_DAYS) {
      it(`buildBaselineSql(${metric}, ${days}) casts every bindable param`, () => {
        expect(untypedParams(buildBaselineSql(metric, days))).toEqual([])
      })
    }
  }

  it('casts the interval window to BIGINT, never INTEGER', () => {
    for (const metric of metrics) {
      const sql = buildBaselineSql(metric, 30)
      // `CAST($p AS INTEGER)` still fails against the interval overloads —
      // INTEGER widens ambiguously. This is not interchangeable with BIGINT.
      expect(sql).not.toMatch(/CAST\(\s*\$windowDays\s+AS\s+INTEGER\s*\)/i)
      expect(sql).toMatch(/CAST\(\s*\$windowDays\s+AS\s+BIGINT\s*\)/i)
    }
  })
})

describe('local-day bucketing converts rather than labels', () => {
  /**
   * `ts` columns are naive `TIMESTAMP`. DuckDB picks the `timezone()`
   * overload from its SECOND argument, so `timezone($tz, ts)` LABELS the
   * naive value with the zone instead of converting into it — attributing
   * evening readings to the next local day (zivaone_app#73).
   */
  it('wraps the ts column in timezone(UTC, …) before the zone conversion', () => {
    for (const metric of getBaselineMetricIds()) {
      const sql = buildBaselineSql(metric, 30)
      if (!sql.includes('timezone('))
        continue // sleep groups by night_of
      expect(sql).toMatch(/timezone\(\s*'UTC'\s*,\s*\w+\s*\)/i)
      expect(sql).not.toMatch(/timezone\(\s*CAST\(\$tz[^)]*\)\s*,\s*ts\s*\)/i)
    }
  })
})

describe('tools/impls bind no untyped interval params', () => {
  const IMPL_DIR = join(__dirname, '..', '..', 'tools', 'impls')
  const FILES = ['spo2.ts', 'hrv.ts', 'sleep.ts', 'activity.ts', 'insights.ts', 'compare.ts', 'anomaly.ts']

  for (const file of FILES) {
    it(`${file} — every INTERVAL parameter is cast`, () => {
      const src = readFileSync(join(IMPL_DIR, file), 'utf8')
      // `INTERVAL (${jsExpr})` is interpolation, not binding — no param
      // reaches the driver, so those are fine. Only `$name` matters.
      const bare = Array.from(src.matchAll(/INTERVAL\s*\(\s*\$([a-z_]\w*)\s*\)/gi), m => m[1])
      expect(bare).toEqual([])
    })
  }

  it('at least one impl actually binds an interval param — guard is not vacuous', () => {
    const bound = FILES.filter(f =>
      /INTERVAL\s*\(\s*CAST\(\s*\$/i.test(readFileSync(join(IMPL_DIR, f), 'utf8')),
    )
    expect(bound.length).toBeGreaterThan(0)
  })
})
