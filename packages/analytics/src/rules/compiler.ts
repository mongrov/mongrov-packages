/**
 * SQL compiler — rule → parameterized DuckDB query.
 *
 * Design principles:
 *   - `$userId`, `$brand`, `$familyId` are always bound via
 *     `analytics.execute(sql, params)`. Never string-concatenated.
 *   - Static rule params (thresholds, window edges) are also bound as
 *     `$<name>`. Never concatenated.
 *   - Table + column identifiers are looked up in `METRIC_METADATA`,
 *     sanitized with `[^A-Za-z0-9_]/g → _`, then inlined as literals.
 *     DuckDB has no parameter binding for identifiers.
 *   - `rawSql` bypasses codegen; the compiler only allow-lists
 *     placeholders declared in `rule.rawSqlParams` (plus the three
 *     runtime-bound ones).
 *
 * The result rowshape is uniform: every SELECT projects
 *   observed_value NUMERIC, threshold_value NUMERIC
 * so the evaluator can build `RuleViolation` without dispatching per
 * target type.
 */

import { METRIC_METADATA } from '../core/metric_metadata'
import type { TableName } from '../core/schemas'
import type { CompiledRule } from './types'
import {
  type Aggregation,
  type Compare,
  type Rule,
  RuleValidationError,
  type Target,
  type Window,
} from './schema'

/** Sanitize an identifier for direct interpolation. */
export function sanitizeIdent(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, '_')
}

/** Timestamp column per table — `sleep_session` uses `ts_start`. */
function tsColumn(table: TableName): string {
  return table === 'sleep_session' ? 'ts_start' : 'ts'
}

/**
 * DuckDB duration literal for `NOW() - INTERVAL '<window>'`. Encodes
 * hours or days explicitly rather than relying on TZ-aware helpers.
 */
function windowInterval(window: Window): string {
  switch (window) {
    case '1h': return `INTERVAL '1 hour'`
    case '6h': return `INTERVAL '6 hours'`
    case '24h': return `INTERVAL '24 hours'`
    case '3d': return `INTERVAL '3 days'`
    case '7d': return `INTERVAL '7 days'`
    case '30d': return `INTERVAL '30 days'`
  }
}

/** SQL fragment mapping an aggregation to its call over `<column>`. */
function aggExpr(agg: Aggregation, column: string, ts: string): string {
  switch (agg) {
    case 'avg': return `AVG(${column})`
    case 'min': return `MIN(${column})`
    case 'max': return `MAX(${column})`
    case 'sum': return `SUM(${column})`
    case 'count': return `COUNT(${column})`
    case 'last': return `arg_max(${column}, ${ts})`
  }
}

/** `HAVING`-style clause for a compare operator. */
function compareClause(compare: Compare, lhs: string, rhs: string): string {
  switch (compare) {
    case 'less_than': return `${lhs} < ${rhs}`
    case 'greater_than': return `${lhs} > ${rhs}`
    case 'equals': return `${lhs} = ${rhs}`
    case 'not_equals': return `${lhs} <> ${rhs}`
    case 'between': throw new Error('between handled per-target')
  }
}

const ALLOWED_RAW_PLACEHOLDERS = new Set(['userId', 'brand', 'familyId'])

/** Extract every `$name` placeholder from a SQL string. */
function placeholdersOf(sql: string): string[] {
  const out: string[] = []
  const re = /\$([A-Za-z_][A-Za-z0-9_]*)/g
  let match: RegExpExecArray | null
  match = re.exec(sql)
  while (match !== null) {
    out.push(match[1])
    match = re.exec(sql)
  }
  return out
}

/** Compile a validated rule to a `CompiledRule`. */
export function compileRule(rule: Rule): CompiledRule {
  const meta = METRIC_METADATA[rule.metric]
  const rawTable = meta.table
  const rawColumn = meta.column
  const table = sanitizeIdent(rawTable)
  const column = sanitizeIdent(rawColumn)

  if (rule.rawSql) {
    return compileRawSql(rule, rule.rawSql)
  }

  const ts = tsColumn(rawTable as TableName)
  const interval = windowInterval(rule.window)

  const filter
    = `WHERE user_id = $userId AND brand = $brand AND family_id = $familyId `
    + `AND ${ts} > NOW() - ${interval}`

  const agg = aggExpr(rule.aggregation, column, ts)
  const params: Record<string, string | number> = {}

  const description = `${rule.metric} ${rule.aggregation} over ${rule.window} ${rule.compare} ${describeTarget(rule.target)}`

  const { sql, params: extraParams } = buildForTarget({
    table,
    ts,
    interval,
    column,
    agg,
    filter,
    target: rule.target,
    compare: rule.compare,
  })
  Object.assign(params, extraParams)

  return {
    ruleId: rule.id,
    metric: rule.metric,
    sql,
    params,
    description,
  }
}

function describeTarget(target: Target): string {
  switch (target.type) {
    case 'absolute': return `${target.value}`
    case 'baseline_percent': return `${target.percent}% of ${target.windowDays}d baseline`
    case 'baseline_stddev': return `${target.stddevs} stddev over ${target.windowDays}d baseline`
    case 'range': return `[${target.min}, ${target.max}]`
  }
}

interface BuildArgs {
  table: string
  ts: string
  interval: string
  column: string
  agg: string
  filter: string
  target: Target
  compare: Compare
}

function buildForTarget(args: BuildArgs): {
  sql: string
  params: Record<string, string | number>
} {
  const { table, ts, column, agg, filter, target, compare } = args

  if (target.type === 'absolute') {
    const params = { threshold_absolute: target.value }
    const sql = `SELECT ${agg} AS observed_value, $threshold_absolute AS threshold_value
FROM ${table}
${filter}
HAVING ${compareClause(compare, 'observed_value', '$threshold_absolute')};`
    return { sql, params }
  }

  if (target.type === 'range') {
    const params = { range_min: target.min, range_max: target.max }
    // For range, `between` violates on values OUTSIDE the range; other
    // compares treat range as a threshold-with-tolerance and use the min
    // bound as threshold_value for reporting.
    const outside
      = compare === 'between'
        ? `NOT (observed_value BETWEEN $range_min AND $range_max)`
        : compareClause(compare, 'observed_value', '$range_min')
    const sql = `SELECT ${agg} AS observed_value, $range_min AS threshold_value
FROM ${table}
${filter}
HAVING ${outside};`
    return { sql, params }
  }

  // Baselines use a CTE for the user's historical mean over windowDays.
  // DuckDB can't parametrize inside an INTERVAL literal, but it can
  // multiply a static unit interval by a bound integer.
  const baselineDaysBind = `(INTERVAL 1 DAY) * $baselineDays`

  if (target.type === 'baseline_percent') {
    const params = {
      baselineDays: target.windowDays,
      pct: target.percent,
    }
    const sql = `WITH baseline AS (
  SELECT AVG(${column}) AS mean
  FROM ${table}
  WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
    AND ${ts} > NOW() - ${baselineDaysBind}
)
SELECT ${agg} AS observed_value,
       (SELECT mean FROM baseline) * ($pct / 100.0) AS threshold_value
FROM ${table}
${filter}
HAVING ${compareClause(compare, 'observed_value', 'threshold_value')};`
    return { sql, params }
  }

  // baseline_stddev
  const params = {
    baselineDays: target.windowDays,
    stddevs: target.stddevs,
  }
  const sql = `WITH baseline AS (
  SELECT AVG(${column}) AS mean, stddev_pop(${column}) AS sd
  FROM ${table}
  WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
    AND ${ts} > NOW() - ${baselineDaysBind}
)
SELECT ${agg} AS observed_value,
       (SELECT mean + $stddevs * sd FROM baseline) AS threshold_value
FROM ${table}
${filter}
HAVING ${compareClause(compare, 'observed_value', 'threshold_value')};`
  return { sql, params }
}

/**
 * Pass-through path with allow-list check. Placeholders must be one of
 * {userId, brand, familyId} or declared in `rule.rawSqlParams`.
 */
function compileRawSql(rule: Rule, rawSql: string): CompiledRule {
  const placeholders = placeholdersOf(rawSql)
  const allowed = new Set(ALLOWED_RAW_PLACEHOLDERS)
  for (const p of rule.rawSqlParams ?? []) {
    allowed.add(p)
  }
  for (const p of placeholders) {
    if (!allowed.has(p)) {
      throw new RuleValidationError(
        `Rule ${rule.id}: rawSql placeholder $${p} not declared in rawSqlParams.`,
      )
    }
  }
  return {
    ruleId: rule.id,
    metric: rule.metric,
    sql: rawSql,
    params: {},
    description: `rawSql:${rule.metric}`,
  }
}
