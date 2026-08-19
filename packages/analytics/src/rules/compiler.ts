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

/** Placeholder the evaluator binds for a `baseline_offset` target's offset. */
export const BASELINE_OFFSET_PARAM = 'baselineOffset'

/**
 * The local-day bucket for a naive-UTC timestamp column.
 *
 * Exported so the compiler and its tests share one definition rather than
 * two that agree today. The nested `timezone('UTC', …)` is load-bearing:
 * DuckDB selects the `timezone()` overload from its SECOND argument, so
 * `timezone($tz, ts)` on a naive column LABELS the value with the zone
 * instead of converting into it, leaving an evening reading on its UTC date
 * (zivaone_app#73).
 */
export function localDayExpr(tsColumn: string): string {
  return `date_trunc('day', timezone(CAST($tz AS VARCHAR), timezone('UTC', ${tsColumn})))`
}

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
    metricId: rule.metric,
  }

  const { sql, params } = rule.cadence === 'day'
    ? buildDayCadence(args)
    : rule.consecutive && rule.consecutive > 1
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
    /** Evaluator binds `$baselineOffset` from this key when present. */
    offsetKey: rule.target.type === 'baseline_offset' ? rule.target.offsetKey : undefined,
    offsetDefault: rule.target.type === 'baseline_offset' ? rule.target.offset : undefined,
    cadence: rule.cadence,
    consecutiveKey: rule.consecutiveKey,
  }
}

function describeTarget(target: Target): string {
  switch (target.type) {
    case 'absolute': return `${target.value}`
    case 'baseline_percent': return `${target.percent}% of ${target.windowDays}d baseline`
    case 'baseline_stddev': return `${target.stddevs} stddev over ${target.windowDays}d baseline`
    case 'range': return `[${target.min}, ${target.max}]`
    case 'user_setting': return `user setting ${target.key} (default ${target.defaultValue})`
    case 'baseline_offset': return (
      `${target.offset} ${target.direction} ${target.windowDays}d baseline p50${
        target.offsetKey ? ` (key ${target.offsetKey})` : ''}`
    )
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
  /** Rule metric id — the `user_baseline.metric` key for baseline_offset. */
  metricId: string
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
  const { view, join, ts, interval, column, agg, target, compare, metricId } = args
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

  if (target.type === 'baseline_offset') {
    // Reads the STORED baseline, not a recomputed mean. `user_baseline.p50`
    // is day-first and ≥20-day gated (principle 27); the inline AVG the
    // other baseline targets use is neither, so recomputing here would let
    // this rule and the user's own "usual range" mean different numbers.
    //
    // Unqualified `user_baseline` resolves to the local catalog, same as the
    // insight INSERT — baselines are local-first.
    //
    // Every parameter is CAST. react-native-duckdb resolves param types from
    // SQL context at prepare time, and a bare param in a projection or an
    // arithmetic expression has none (zivaone_app#70/#72).
    const params: Record<string, string | number> = {
      baselineDays: target.windowDays,
      baselineMetric: metricId,
    }
    // Bound at eval time when `offsetKey` is set; otherwise the evaluator
    // binds the literal default. Either way the SQL is identical, so one
    // compiled statement serves every user in the family.
    if (target.offsetKey === undefined)
      params.baselineOffset = target.offset

    const sign = target.direction === 'below' ? '-' : '+'
    const operator = target.direction === 'below' ? 'less_than' : 'greater_than'

    const sql = `WITH baseline AS (
  SELECT p50
  FROM user_baseline
  WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
    AND metric = CAST($baselineMetric AS VARCHAR)
    AND window_days = CAST($baselineDays AS INTEGER)
)
SELECT ${agg} AS observed_value,
       (SELECT p50 FROM baseline) ${sign} CAST($baselineOffset AS DOUBLE) AS threshold_value
${from}
${where}
HAVING ${compareClause(operator, 'observed_value', 'threshold_value')};`
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
/**
 * `cadence: 'day'` — collapse to one value per LOCAL day, then count runs of
 * days (sprint6 T-04).
 *
 * Not a variant of `buildConsecutive`. That builder rejects baseline targets
 * because a per-sample comparison has no stable threshold; here the threshold
 * IS stable for the whole window (a stored `user_baseline` row), and the
 * things being compared are daily aggregates. Different shape, different
 * builder.
 *
 * Three things the SQL has to get right, each of which has already been a bug
 * somewhere in this codebase:
 *
 *   1. **Direction of the zone conversion.** `ts` is naive UTC, and DuckDB
 *      picks the `timezone()` overload from its SECOND argument — so
 *      `timezone($tz, ts)` LABELS the value rather than converting it, which
 *      attributed evening readings to the next local day (zivaone_app#73).
 *      The inner `timezone('UTC', ts)` is what makes it a conversion.
 *   2. **The partial current day is excluded.** Today is still accumulating;
 *      including it lets a quiet morning break a run that the full day would
 *      have continued, so a 3-day rule would fire or not depending on the
 *      hour it happened to run.
 *   3. **Every parameter is CAST**, for the react-native-duckdb prepare path
 *      (zivaone_app#70/#72).
 */
function buildDayCadence(args: BuildArgs): {
  sql: string
  params: Record<string, string | number>
} {
  const { view, join, ts, interval, target, consecutive, metricId, agg } = args

  if (target.type !== 'baseline_offset' && target.type !== 'absolute'
    && target.type !== 'user_setting') {
    throw new RuleValidationError(
      `cadence 'day' supports absolute, user_setting and baseline_offset `
      + `targets; got '${target.type}'.`,
    )
  }

  const params: Record<string, string | number> = {}
  // Daily aggregate — the same collapse `user_baseline` performs, so the two
  // agree about what a day's value is, not merely about where it starts.
  const dailyAgg = agg
  const localDay = localDayExpr(`m.${ts}`)

  let thresholdExpr: string
  let baselineCte = ''
  if (target.type === 'absolute') {
    params.threshold_absolute = target.value
    thresholdExpr = 'CAST($threshold_absolute AS DOUBLE)'
  }
  else if (target.type === 'user_setting') {
    thresholdExpr = `CAST($${USER_SETTING_PARAM} AS DOUBLE)`
  }
  else {
    params.baselineDays = target.windowDays
    params.baselineMetric = metricId
    if (target.offsetKey === undefined)
      params.baselineOffset = target.offset
    const sign = target.direction === 'below' ? '-' : '+'
    baselineCte = `baseline AS (
  SELECT p50
  FROM user_baseline
  WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
    AND metric = CAST($baselineMetric AS VARCHAR)
    AND window_days = CAST($baselineDays AS INTEGER)
),
`
    thresholdExpr = `(SELECT p50 FROM baseline) ${sign} CAST($${BASELINE_OFFSET_PARAM} AS DOUBLE)`
  }

  const direction = target.type === 'baseline_offset' && target.direction === 'above'
    ? 'greater_than'
    : target.type === 'baseline_offset'
      ? 'less_than'
      : args.compare
  const extreme = direction === 'greater_than' ? 'MAX' : 'MIN'

  const sql = `WITH ${baselineCte}daily AS (
  SELECT ${localDay} AS day,
         ${dailyAgg} AS value
  FROM ${view} m${join}
  WHERE m.user_id = $userId AND m.brand = $brand AND m.family_id = $familyId
    AND m.${ts} > NOW() - ${interval}
  GROUP BY day
  -- Exclude today: it is still accumulating, and a half-finished day would
  -- make the same rule fire or not depending on the hour it ran.
  HAVING day < date_trunc('day', timezone(CAST($tz AS VARCHAR), NOW()))
),
marked AS (
  SELECT day, value,
         (${compareClause(direction, 'value', thresholdExpr)}) AS breached,
         ${thresholdExpr} AS threshold_value
  FROM daily
),
breaches AS (
  SELECT day, value, threshold_value FROM marked WHERE breached
),
runs AS (
  -- Islands keyed on the CALENDAR DATE, not on row position.
  --
  -- The previous key was a difference of ROW_NUMBERs over the rows present in
  -- the daily CTE, and a day with no readings produces no row — so two
  -- breaching days either side of an unworn day were adjacent and counted as
  -- consecutive. The rule inferred a run across silence. Measured: breaches
  -- on day-4 and day-2 with day-3 empty fired a consecutive:2 rule.
  --
  -- date-minus-rownum is constant only across consecutive dates, so a gap of
  -- any length starts a new island. A run must be OBSERVED
  -- (resync-2026-08-19 §2a).
  --
  -- No backticks in this comment: it sits inside a JS template literal.
  SELECT day, value, threshold_value,
         CAST(day AS DATE) - CAST(ROW_NUMBER() OVER (ORDER BY day) AS INTEGER) AS run_key
  FROM breaches
)
SELECT ${extreme}(value) AS observed_value,
       ANY_VALUE(threshold_value) AS threshold_value
FROM runs
GROUP BY run_key
HAVING COUNT(*) >= CAST($consecutive AS BIGINT)
ORDER BY observed_value ${direction === 'greater_than' ? 'DESC' : 'ASC'}
LIMIT 1;`

  return { sql, params: { ...params, consecutive: consecutive ?? 2 } }
}

function buildConsecutive(args: BuildArgs): {
  sql: string
  params: Record<string, string | number>
} {
  const { view, join, ts, interval, column, target, compare, consecutive, metricId } = args

  // Cadence in minutes, for slot adjacency below. `sampling_minutes` is the
  // metric's nominal grid; `per_session` metrics have no reading cadence and
  // never reach a reading-cadence rule.
  const meta = (METRIC_METADATA as Record<string, { sampling_minutes?: number | string }>)[metricId]
  const sampling = meta?.sampling_minutes
  if (typeof sampling !== 'number') {
    throw new RuleValidationError(
      `Rule on ${metricId}: reading-cadence 'consecutive' needs a numeric `
      + `sampling_minutes to define slot adjacency; got '${String(sampling)}'.`,
    )
  }
  const cadenceMinutes = sampling
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
         -- Islands keyed on the CADENCE SLOT, not on row position.
         --
         -- This was a difference of ROW_NUMBERs over the rows present, so a
         -- missed reading produced no row and its neighbours became adjacent.
         -- Measured: breaching readings at 01:00, 02:00 and 05:00 fired a
         -- consecutive:3 rule exactly as three adjacent readings did. SpO2's
         -- Rule B has run on that since Sprint 5.
         --
         -- Consecutive means adjacent on the metric's cadence grid with no
         -- missing slot between — stated in cadence, not clock time. The slot
         -- index comes from the reading's own timestamp, so insertion order
         -- and batch arrival are irrelevant: readings landing together in one
         -- sync batch still key on when they were TAKEN.
         --
         -- epoch() is absolute, so a DST boundary inside a run does not shift
         -- slot adjacency — that case holds by construction, not by a special
         -- case.
         CAST(epoch(ts) / 60 / ${cadenceMinutes} AS BIGINT)
           - ROW_NUMBER() OVER (ORDER BY ts) AS run_key
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
