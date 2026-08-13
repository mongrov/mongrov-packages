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
 *
 * ## v0.2.0 additions (Sprint 5 §4)
 *
 * - **`context`** (T-17) — an INNER JOIN, not a post-filter. "SpO₂ during
 *   sleep" must aggregate over sleep samples only; computing over
 *   everything and labelling the result would report a number nobody asked
 *   for.
 * - **`consecutive: n`** (T-18) — run-length detection via gaps-and-islands.
 *   `n <= 1` stays on the aggregate path, because "any single breach" is
 *   already expressible as `aggregation: 'min'` + `less_than`.
 * - **`target.type: 'user_setting'`** (T-19) — emits a `$userSettingValue`
 *   placeholder the evaluator binds from KVStore at eval time. The compiled
 *   SQL is threshold-agnostic and therefore cacheable across users.
 * - **Views** (T-20) — all generated SQL reads `v_{table}`, never
 *   `local.{table}` or `r2.default.{table}` (principle 19).
 */

import type { TableName } from '../core/schemas'
import type { Aggregation, Compare, Rule, RuleContext, Target, Window } from './schema'
import type { CompiledRule } from './types'
import { METRIC_METADATA } from '../core/metric_metadata'
import {

  RuleValidationError,

} from './schema'

/** Sanitize an identifier for direct interpolation. */
// PLACEHOLDER_RE carries `g` and is driven with `.exec`; the loop in
// placeholdersOf runs to exhaustion, which resets lastIndex to 0.
const NON_WORD_RE = /\W/g
const PLACEHOLDER_RE = /\$([A-Z_]\w*)/gi

export function sanitizeIdent(raw: string): string {
  return raw.replace(NON_WORD_RE, '_')
}

/**
 * Union-view name for a table (T-20, principle 19). Reading the view is
 * what makes a rule see rows flushed locally but not yet pushed to R2 —
 * i.e. this morning's sync, which is exactly the data a rule fires on.
 */
export function viewFor(table: string): string {
  return `v_${sanitizeIdent(table)}`
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

/**
 * T-17 — INNER JOIN restricting samples to a physiological context.
 *
 * Aliased `m` for the metric relation throughout. Both joins carry the
 * full tenant triple, not just `user_id`: a join on user alone would match
 * another brand's sleep sessions for the same person on a multi-brand
 * install.
 */
export function emitContextJoin(context: RuleContext): string {
  switch (context) {
    case 'any':
      return ''
    case 'asleep':
      return `
INNER JOIN ${viewFor('sleep_session')} s
   ON s.user_id = m.user_id
  AND s.brand = m.brand
  AND s.family_id = m.family_id
  AND m.ts BETWEEN s.ts_start AND s.ts_end`
    case 'resting':
      // Activity rows are 1-minute after unnest, so a sample is "resting"
      // when its own minute recorded zero steps.
      return `
INNER JOIN ${viewFor('activity')} a
   ON a.user_id = m.user_id
  AND a.brand = m.brand
  AND a.family_id = m.family_id
  AND a.ts = date_trunc('minute', m.ts)
  AND a.steps = 0`
  }
}

const ALLOWED_RAW_PLACEHOLDERS = new Set(['userId', 'brand', 'familyId'])

/** Extract every `$name` placeholder from a SQL string. */
function placeholdersOf(sql: string): string[] {
  const out: string[] = []
  let match: RegExpExecArray | null
  match = PLACEHOLDER_RE.exec(sql)
  while (match !== null) {
    out.push(match[1])
    match = PLACEHOLDER_RE.exec(sql)
  }
  return out
}

/**
 * Placeholder the evaluator binds from KVStore for `user_setting` targets
 * (T-19/T-23). Exported so the evaluator and its tests agree on the name.
 */
export const USER_SETTING_PARAM = 'userSettingValue'

/** Compile a validated rule to a `CompiledRule`. */
export function compileRule(rule: Rule): CompiledRule {
  const meta = METRIC_METADATA[rule.metric]
  const rawTable = meta.table
  const column = sanitizeIdent(meta.column)
  const view = viewFor(rawTable)

  if (rule.rawSql) {
    return compileRawSql(rule, rule.rawSql)
  }

  const ts = tsColumn(rawTable as TableName)
  const interval = windowInterval(rule.window)
  const join = emitContextJoin(rule.context)

  const description
    = `${rule.metric} ${rule.aggregation} over ${rule.window} ${rule.compare} `
      + `${describeTarget(rule.target)}${
        rule.context === 'any' ? '' : ` [${rule.context}]`
      }${rule.consecutive && rule.consecutive > 1 ? ` x${rule.consecutive} consecutive` : ''}`

  const args: BuildArgs = {
    view,
    join,
    ts,
    interval,
    column,
    agg: aggExpr(rule.aggregation, `m.${column}`, `m.${ts}`),
    target: rule.target,
    compare: rule.compare,
    consecutive: rule.consecutive,
  }

  const { sql, params } = rule.consecutive && rule.consecutive > 1
    ? buildConsecutive(args)
    : buildForTarget(args)

  return {
    ruleId: rule.id,
    metric: rule.metric,
    sql,
    params,
    description,
    /** Evaluator binds `$userSettingValue` from this key when present. */
    userSettingKey: rule.target.type === 'user_setting' ? rule.target.key : undefined,
    userSettingDefault: rule.target.type === 'user_setting' ? rule.target.defaultValue : undefined,
  }
}

function describeTarget(target: Target): string {
  switch (target.type) {
    case 'absolute': return `${target.value}`
    case 'baseline_percent': return `${target.percent}% of ${target.windowDays}d baseline`
    case 'baseline_stddev': return `${target.stddevs} stddev over ${target.windowDays}d baseline`
    case 'range': return `[${target.min}, ${target.max}]`
    case 'user_setting': return `user setting ${target.key} (default ${target.defaultValue})`
  }
}

interface BuildArgs {
  view: string
  join: string
  ts: string
  interval: string
  column: string
  agg: string
  target: Target
  compare: Compare
  consecutive?: number
}

/** Tenant + window predicate, shared by both paths. */
function whereClause(ts: string, interval: string): string {
  return (
    `WHERE m.user_id = $userId AND m.brand = $brand AND m.family_id = $familyId\n`
    + `  AND m.${ts} > NOW() - ${interval}`
  )
}

function buildForTarget(args: BuildArgs): {
  sql: string
  params: Record<string, string | number>
} {
  const { view, join, ts, interval, column, agg, target, compare } = args
  const where = whereClause(ts, interval)
  const from = `FROM ${view} m${join}`

  if (target.type === 'absolute') {
    const params = { threshold_absolute: target.value }
    const sql = `SELECT ${agg} AS observed_value, $threshold_absolute AS threshold_value
${from}
${where}
HAVING ${compareClause(compare, 'observed_value', '$threshold_absolute')};`
    return { sql, params }
  }

  if (target.type === 'user_setting') {
    // T-19: threshold is a bound param resolved at eval time, so the same
    // compiled SQL serves every user in the family and survives the user
    // changing their setting — no cache invalidation needed.
    const sql = `SELECT ${agg} AS observed_value, $${USER_SETTING_PARAM} AS threshold_value
${from}
${where}
HAVING ${compareClause(compare, 'observed_value', `$${USER_SETTING_PARAM}`)};`
    return { sql, params: {} }
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
${from}
${where}
HAVING ${outside};`
    return { sql, params }
  }

  // Baselines use a CTE for the user's historical mean over windowDays.
  // DuckDB can't parametrize inside an INTERVAL literal, but it can
  // multiply a static unit interval by a bound integer.
  const baselineDaysBind = `(INTERVAL 1 DAY) * $baselineDays`
  const baselineFrom = `FROM ${view} m${join}`
  const baselineWhere
    = `WHERE m.user_id = $userId AND m.brand = $brand AND m.family_id = $familyId\n`
      + `    AND m.${ts} > NOW() - ${baselineDaysBind}`

  if (target.type === 'baseline_percent') {
    const params = { baselineDays: target.windowDays, pct: target.percent }
    const sql = `WITH baseline AS (
  SELECT AVG(m.${column}) AS mean
  ${baselineFrom}
  ${baselineWhere}
)
SELECT ${agg} AS observed_value,
       (SELECT mean FROM baseline) * ($pct / 100.0) AS threshold_value
${from}
${where}
HAVING ${compareClause(compare, 'observed_value', 'threshold_value')};`
    return { sql, params }
  }

  // baseline_stddev
  const params = { baselineDays: target.windowDays, stddevs: target.stddevs }
  const sql = `WITH baseline AS (
  SELECT AVG(m.${column}) AS mean, stddev_pop(m.${column}) AS sd
  ${baselineFrom}
  ${baselineWhere}
)
SELECT ${agg} AS observed_value,
       (SELECT mean + $stddevs * sd FROM baseline) AS threshold_value
${from}
${where}
HAVING ${compareClause(compare, 'observed_value', 'threshold_value')};`
  return { sql, params }
}

/**
 * T-18 — `consecutive: n` via gaps-and-islands.
 *
 * A run of adjacent breaching samples is identified by the classic
 * difference of two row numbers: one over all samples in time order, one
 * partitioned by the breach flag. Within a maximal run of same-flag rows
 * that difference is constant, so it serves as a group key.
 *
 * The rule fires when ANY breaching run reaches length `n`. `observed_value`
 * is the run's extreme in the direction of the comparison — the worst
 * reading in the run, which is what a user-facing card should quote.
 *
 * Only supported for the threshold-style targets. Baseline targets would
 * need the baseline resolved per-sample rather than per-window, which is a
 * different query shape and has no consumer in v0.2.0 — the validator
 * rejects the combination rather than silently emitting something subtly
 * wrong.
 */
function buildConsecutive(args: BuildArgs): {
  sql: string
  params: Record<string, string | number>
} {
  const { view, join, ts, interval, column, target, compare, consecutive } = args
  const where = whereClause(ts, interval)
  const from = `FROM ${view} m${join}`

  let thresholdExpr: string
  let params: Record<string, string | number> = {}
  if (target.type === 'absolute') {
    thresholdExpr = '$threshold_absolute'
    params = { threshold_absolute: target.value }
  }
  else if (target.type === 'user_setting') {
    thresholdExpr = `$${USER_SETTING_PARAM}`
  }
  else if (target.type === 'range') {
    thresholdExpr = '$range_min'
    params = { range_min: target.min, range_max: target.max }
  }
  else {
    throw new RuleValidationError(
      `consecutive is not supported with target.type '${target.type}' — `
      + `baseline targets resolve per-window, not per-sample. Use an absolute `
      + `or user_setting target, or drop consecutive.`,
    )
  }

  // Worst reading in the run, in the direction of the comparison.
  const extreme = compare === 'greater_than' ? 'MAX' : 'MIN'
  const breach
    = compare === 'between'
      ? `NOT (m.${column} BETWEEN $range_min AND $range_max)`
      : compareClause(compare, `m.${column}`, thresholdExpr)

  const sql = `WITH samples AS (
  SELECT m.${ts} AS ts,
         m.${column} AS value,
         (${breach}) AS breached,
         ${thresholdExpr} AS threshold_value
  ${from}
  ${where}
),
runs AS (
  SELECT ts, value, breached, threshold_value,
         ROW_NUMBER() OVER (ORDER BY ts)
           - ROW_NUMBER() OVER (PARTITION BY breached ORDER BY ts) AS run_key
  FROM samples
)
SELECT ${extreme}(value) AS observed_value,
       ANY_VALUE(threshold_value) AS threshold_value
FROM runs
WHERE breached
GROUP BY run_key
HAVING COUNT(*) >= $consecutive
ORDER BY observed_value ${compare === 'greater_than' ? 'DESC' : 'ASC'}
LIMIT 1;`

  return { sql, params: { ...params, consecutive: consecutive as number } }
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
