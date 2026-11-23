/**
 * SQL compiler — rule → parameterized DuckDB query.
 *
 * Design principles:
 *   - `$userId`, `$brand`, `$familyId` are always bound via
 *     `analytics.execute(sql, params)`. Never string-concatenated.
 *   - Static rule params (thresholds, window edges) are also bound as
 *     `$<name>`. Never concatenated.
 *   - Table + column identifiers are looked up in the registered metrics,
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
 * - **`context`** (T-17) — an INNER JOIN, not a post-filter. "metric M
 *   during X" must aggregate over the samples in X only; computing over
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

import type { Aggregation, BaselinePercentile, Compare, Rule, RuleContext, Target, Window } from './schema'
import type { CompiledRule } from './types'
import { boundedRelation, daysInterval, hoursInterval, SPARE_DAYS } from '../core/bounded-read'
import { metricDefinition } from '../core/metrics'
import { cleanRelation, hasQualityRelations, qualityRelation, readRelation } from '../core/relations'
import { timeColumnFor } from '../core/table_metadata'
import { contextJoin } from './contexts'
import {
  BASELINE_PERCENTILES,
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

/** Timestamp column per table — the table's registered `timeColumn`. */
function tsColumn(table: string): string {
  return timeColumnFor(table)
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

/** A rule window in hours, for the bounded read's lookback. */
const WINDOW_HOURS: Record<Window, number> = {
  '1h': 1,
  '6h': 6,
  '24h': 24,
  '3d': 72,
  '7d': 168,
  '30d': 720,
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
    // Inclusive forms: a threshold the user picked is a value they expect to
    // count, not one to sit just outside.
    case 'greater_than_or_equal': return `${lhs} >= ${rhs}`
    case 'less_than_or_equal': return `${lhs} <= ${rhs}`
    case 'equals': return `${lhs} = ${rhs}`
    case 'not_equals': return `${lhs} <> ${rhs}`
    case 'between': throw new Error('between handled per-target')
  }
}

/**
 * T-17 — the JOIN restricting samples to a context (`pack.rules.contexts`;
 * `any` adds none). Aliased `m` for the metric relation throughout.
 */
export function emitContextJoin(context: RuleContext, table?: string, qualityRelation?: string): string {
  return contextJoin(context, { table: table ?? '', qualityRelation })
}

/**
 * The user's IANA zone. Bound by the evaluator for day cadence, `minDays`,
 * and any `rawSql` body that reads it.
 */
export const TZ_PARAM = 'tz'

/**
 * The device a `rawSql` body is scoped to. Bound by the evaluator from
 * `userDeviceProvider`; NULL when it names none.
 */
export const DEVICE_ID_PARAM = 'deviceId'

const ALLOWED_RAW_PLACEHOLDERS = new Set(['userId', 'brand', 'familyId', TZ_PARAM, DEVICE_ID_PARAM])

/** Names a `rawSqlSettings` entry may not take: the evaluator binds these itself. */
const RESERVED_RAW_PLACEHOLDERS: ReadonlySet<string> = ALLOWED_RAW_PLACEHOLDERS

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

/** Placeholder the evaluator binds for a `phase_band` target's half-width multiplier. */
export const BAND_SCALE_PARAM = 'bandScale'

/**
 * The local-day bucket for a naive-UTC timestamp column.
 *
 * Exported so the compiler and its tests share one definition rather than
 * two that agree today. The nested `timezone('UTC', …)` is load-bearing:
 * DuckDB selects the `timezone()` overload from its SECOND argument, so
 * `timezone($tz, ts)` on a naive column LABELS the value with the zone
 * instead of converting into it, leaving an evening reading on its UTC date.
 */
export function localDayExpr(tsColumn: string): string {
  return `date_trunc('day', timezone(CAST($tz AS VARCHAR), timezone('UTC', ${tsColumn})))`
}

/**
 * The `user_baseline` column a `baseline_offset` target compares against.
 * From the schema's enum, re-checked here because it is inlined as an
 * identifier; `p50` when the target does not name one.
 */
function baselinePercentileColumn(target: Extract<Target, { type: 'baseline_offset' }>): BaselinePercentile {
  const pct = target.percentile ?? 'p50'
  if (!BASELINE_PERCENTILES.includes(pct))
    throw new RuleValidationError(`baseline_offset percentile '${String(pct)}' is not one of ${BASELINE_PERCENTILES.join(', ')}.`)
  return pct
}

/** Compile a validated rule to a `CompiledRule`. */
export function compileRule(rule: Rule): CompiledRule {
  const meta = metricDefinition(rule.metric)
  if (!meta)
    throw new RuleValidationError(`Rule ${rule.id}: metric ${rule.metric} is not registered by any pack.`)
  const rawTable = meta.table
  const column = sanitizeIdent(meta.column)
  const table = sanitizeIdent(rawTable)
  // A rule is a claim, so it reads the metric's clean relation (T-25 consume
  // rule): a reading its pack's quality views exclude can never fire an alert.
  const view = readRelation(table)

  if (rule.rawSql) {
    return compileRawSql(rule, rule.rawSql)
  }

  const ts = tsColumn(rawTable)
  const interval = windowInterval(rule.window)

  const description
    = `${rule.metric} ${rule.aggregation} over ${rule.window} ${rule.compare} `
      + `${describeTarget(rule.target)}${
        rule.context === 'any' ? '' : ` [${rule.context}]`
      }${rule.consecutive && rule.consecutive > 1 ? ` x${rule.consecutive} consecutive` : ''}${
        rule.minDays !== undefined ? ` [>=${rule.minDays} days of data]` : ''}`

  /*
   * The FROM clause, per scope and per form (mongrov-packages#44).
   *
   * `view`: the full-history views, as always — `CompiledRule.sql`.
   * `bounded`: the same relations through their `_between` macros —
   * `CompiledRule.boundedSql`. Every WHERE stays as it is, so the bounds only
   * have to cover the rows each scope's own `ts >` predicate selects:
   *
   *   window    `ts > NOW() - <rule.window>`
   *   baseline  `ts > NOW() - $baselineDays days`
   *
   * Nothing downstream reads outside its scope's rows: consecutive runs,
   * day cadence, min-days and the `phase_band` target all work on the
   * filtered samples, and a context's quality join matches `rq.ts = m.ts`. So the window is the
   * whole lookback, plus the spare day for the session zone (bounded-read).
   */
  const fromFor = (form: 'view' | 'bounded') => (scope: Scope): string => {
    if (form === 'view' || !hasQualityRelations(table))
      return `FROM ${view} m${emitContextJoin(rule.context, table)}`
    const back = scope === 'window'
      ? hoursInterval(WINDOW_HOURS[rule.window] + 24 * SPARE_DAYS)
      : daysInterval(`(CAST($baselineDays AS BIGINT) + ${SPARE_DAYS})`)
    const rq = boundedRelation(qualityRelation(table)!, { back })
    return `FROM ${boundedRelation(cleanRelation(table)!, { back })} m${emitContextJoin(rule.context, table, rq)}`
  }

  const args: BuildArgs = {
    from: fromFor('view'),
    ts,
    interval,
    column,
    agg: aggExpr(rule.aggregation, `m.${column}`, `m.${ts}`),
    target: rule.target,
    compare: rule.compare,
    consecutive: rule.consecutive,
    metricId: rule.metric,
    minDays: rule.minDays,
  }

  const build = (a: BuildArgs) => rule.cadence === 'day'
    ? buildDayCadence(a)
    : rule.consecutive && rule.consecutive > 1
      ? buildConsecutive(a)
      : buildForTarget(a)
  const { sql, params } = build(args)
  const boundedSql = hasQualityRelations(table)
    ? build({ ...args, from: fromFor('bounded') }).sql
    : undefined

  return {
    ruleId: rule.id,
    metric: rule.metric,
    sql,
    boundedSql,
    params: rule.minDays !== undefined ? { ...params, minDays: rule.minDays } : params,
    description,
    /** Evaluator binds `$userSettingValue` from this key when present. */
    userSettingKey: rule.target.type === 'user_setting' ? rule.target.key : undefined,
    userSettingDefault: rule.target.type === 'user_setting' ? rule.target.defaultValue : undefined,
    /** Evaluator binds `$baselineOffset` from this key when present. */
    offsetKey: rule.target.type === 'baseline_offset' ? rule.target.offsetKey : undefined,
    offsetDefault: rule.target.type === 'baseline_offset' ? rule.target.offset : undefined,
    cadence: rule.cadence,
    consecutiveKey: rule.consecutiveKey,
    minDays: rule.minDays,
    /** Evaluator binds `$bandScale` from this key when present. */
    bandScaleKey: rule.target.type === 'phase_band' ? rule.target.scaleKey : undefined,
    bandScales: rule.target.type === 'phase_band' ? rule.target.scales : undefined,
    bandScaleDefault: rule.target.type === 'phase_band' ? rule.target.defaultScale : undefined,
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
      `${target.offset} ${target.direction} ${target.windowDays}d baseline ${target.percentile ?? 'p50'}${
        target.offsetKey ? ` (key ${target.offsetKey})` : ''}`
    )
    case 'phase_band': return (
      `outside ${target.band} band (${target.windowDays}d, default [${target.defaultLo}, ${target.defaultHi}]${
        target.scaleKey ? `, scaled by ${target.scaleKey}` : ''})`
    )
  }
}

/** Which predicate a FROM serves: the rule's window, or a baseline CTE's. */
type Scope = 'window' | 'baseline'

interface BuildArgs {
  /** `FROM <relation> m<context join>` for that scope. */
  from: (scope: Scope) => string
  ts: string
  interval: string
  column: string
  agg: string
  target: Target
  compare: Compare
  consecutive?: number
  /** Rule metric id — the `user_baseline.metric` key for baseline_offset. */
  metricId: string
  /** Distinct local days with data required in the window. */
  minDays?: number
}

/** Tenant + window predicate, shared by both paths. */
function whereClause(ts: string, interval: string): string {
  return (
    `WHERE m.user_id = $userId AND m.brand = $brand AND m.family_id = $familyId\n`
    + `  AND m.${ts} > NOW() - ${interval}`
  )
}

/*
 * Every bound threshold is CAST where it is used.
 *
 * react-native-duckdb prepares with NO values and binds afterwards, so a
 * param's type must resolve from SQL context at prepare time. A bare param
 * alone in a projection (`$threshold_absolute AS threshold_value`), compared
 * with a select-list alias, or multiplied into an INTERVAL has no context,
 * stays UNKNOWN, and throws ParameterNotResolvedException — which is not
 * transaction-exempt, so it also invalidates the shared connection and the
 * NEXT unrelated query fails. Stock DuckDB supplies values to the binder and
 * does not reproduce it; `param-casts.test.ts` is the guard.
 *
 * DOUBLE for thresholds (compared with AVG/MIN/MAX). BIGINT, not INTEGER, for
 * interval arithmetic and counts: `CAST($p AS INTEGER)` still fails on device.
 * The tenant triple compares to VARCHAR columns, resolves, and stays bare.
 */
const THRESHOLD_ABSOLUTE = 'CAST($threshold_absolute AS DOUBLE)'
const RANGE_MIN = 'CAST($range_min AS DOUBLE)'
const RANGE_MAX = 'CAST($range_max AS DOUBLE)'
const USER_SETTING_VALUE = `CAST($${USER_SETTING_PARAM} AS DOUBLE)`

function buildForTarget(args: BuildArgs): {
  sql: string
  params: Record<string, string | number>
} {
  const { ts, interval, column, agg, target, compare, metricId } = args
  const where = whereClause(ts, interval)
  const from = args.from('window')
  // A window aggregate over too few days of data measures the gaps, not the
  // user. Local days, so a late-evening reading counts for its day.
  const floor = args.minDays !== undefined
    ? `\n   AND COUNT(DISTINCT ${localDayExpr(`m.${ts}`)}) >= CAST($minDays AS BIGINT)`
    : ''

  if (target.type === 'phase_band') {
    // The validator requires `consecutive >= 2` for this target; a window
    // aggregate has no side of the band to report.
    throw new RuleValidationError(
      `phase_band targets need consecutive >= 2 (reading cadence).`,
    )
  }

  if (target.type === 'absolute') {
    const params = { threshold_absolute: target.value }
    const sql = `SELECT ${agg} AS observed_value, ${THRESHOLD_ABSOLUTE} AS threshold_value
${from}
${where}
HAVING ${compareClause(compare, 'observed_value', THRESHOLD_ABSOLUTE)}${floor};`
    return { sql, params }
  }

  if (target.type === 'user_setting') {
    // T-19: threshold is a bound param resolved at eval time, so the same
    // compiled SQL serves every user in the family and survives the user
    // changing their setting — no cache invalidation needed.
    const sql = `SELECT ${agg} AS observed_value, ${USER_SETTING_VALUE} AS threshold_value
${from}
${where}
HAVING ${compareClause(compare, 'observed_value', USER_SETTING_VALUE)}${floor};`
    return { sql, params: {} }
  }

  if (target.type === 'range') {
    const params = { range_min: target.min, range_max: target.max }
    // For range, `between` violates on values OUTSIDE the range; other
    // compares treat range as a threshold-with-tolerance and use the min
    // bound as threshold_value for reporting.
    const outside
      = compare === 'between'
        ? `NOT (observed_value BETWEEN ${RANGE_MIN} AND ${RANGE_MAX})`
        : compareClause(compare, 'observed_value', RANGE_MIN)
    const sql = `SELECT ${agg} AS observed_value, ${RANGE_MIN} AS threshold_value
${from}
${where}
HAVING ${outside}${floor};`
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
    // arithmetic expression has none.
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
    const pct = baselinePercentileColumn(target)

    const sql = `WITH baseline AS (
  SELECT ${pct}
  FROM user_baseline
  WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
    AND metric = CAST($baselineMetric AS VARCHAR)
    AND window_days = CAST($baselineDays AS INTEGER)
)
SELECT ${agg} AS observed_value,
       (SELECT ${pct} FROM baseline) ${sign} CAST($baselineOffset AS DOUBLE) AS threshold_value
${from}
${where}
HAVING ${compareClause(operator, 'observed_value', 'threshold_value')}${floor};`
    return { sql, params }
  }

  // Baselines use a CTE for the user's historical mean over windowDays.
  // DuckDB can't parametrize inside an INTERVAL literal, but it can
  // multiply a static unit interval by a bound integer — BIGINT, because an
  // INTEGER operand widens ambiguously and fails to bind on device.
  const baselineDaysBind = `(INTERVAL 1 DAY) * CAST($baselineDays AS BIGINT)`
  const baselineFrom = args.from('baseline')
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
       (SELECT mean FROM baseline) * (CAST($pct AS DOUBLE) / 100.0) AS threshold_value
${from}
${where}
HAVING ${compareClause(compare, 'observed_value', 'threshold_value')}${floor};`
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
       (SELECT mean + CAST($stddevs AS DOUBLE) * sd FROM baseline) AS threshold_value
${from}
${where}
HAVING ${compareClause(compare, 'observed_value', 'threshold_value')}${floor};`
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
 *      attributed evening readings to the next local day.
 *      The inner `timezone('UTC', ts)` is what makes it a conversion.
 *   2. **The partial current day is excluded.** Today is still accumulating;
 *      including it lets a quiet morning break a run that the full day would
 *      have continued, so a 3-day rule would fire or not depending on the
 *      hour it happened to run.
 *   3. **Every parameter is CAST**, for the react-native-duckdb prepare path.
 */
/**
 * Min readings before a day counts, as a fraction of the day's slots.
 *
 * 25% of `1440 / sampling_minutes`: 12 for a 30-minute metric (48 slots),
 * 6 for an hourly one (24), 36 for a 10-minute one (144). Derived rather than tabulated, so a next-gen
 * cadence moves every floor at once instead of leaving five constants to
 * chase.
 */
export const MIN_DAY_READINGS_FRACTION = 0.25

export function minDayReadings(samplingMinutes: number): number {
  return Math.round((1440 / samplingMinutes) * MIN_DAY_READINGS_FRACTION)
}

function buildDayCadence(args: BuildArgs): {
  sql: string
  params: Record<string, string | number>
} {
  const { ts, interval, target, consecutive, metricId, agg } = args

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

  // Same floor the screen uses, from the same derivation — see minDayReadings.
  const dayMeta = metricDefinition(metricId)
  const daySampling = dayMeta?.sampling_minutes
  if (typeof daySampling !== 'number') {
    throw new RuleValidationError(
      `Rule on ${metricId}: cadence 'day' needs a numeric sampling_minutes to `
      + `derive its min-data floor; got '${String(daySampling)}'.`,
    )
  }
  const dayFloor = minDayReadings(daySampling)

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
    const pct = baselinePercentileColumn(target)
    baselineCte = `baseline AS (
  SELECT ${pct}
  FROM user_baseline
  WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
    AND metric = CAST($baselineMetric AS VARCHAR)
    AND window_days = CAST($baselineDays AS INTEGER)
),
`
    thresholdExpr = `(SELECT ${pct} FROM baseline) ${sign} CAST($${BASELINE_OFFSET_PARAM} AS DOUBLE)`
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
  ${args.from('window')}
  WHERE m.user_id = $userId AND m.brand = $brand AND m.family_id = $familyId
    AND m.${ts} > NOW() - ${interval}
  GROUP BY day
  -- Exclude today: it is still accumulating, and a half-finished day would
  -- make the same rule fire or not depending on the hour it ran.
  --
  -- And exclude a day below the min-data floor. A rule firing on a day the
  -- SCREEN renders as missing is a contradiction the user can see — a
  -- notification about a day the app says it has no data for. A thin day is
  -- neither above nor below: it is ABSENT, which the calendar-keyed islands
  -- below then treat as breaking the run, exactly like a day with no data.
  HAVING day < date_trunc('day', timezone(CAST($tz AS VARCHAR), NOW()))
     AND COUNT(*) >= ${dayFloor}
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
  -- breaching days either side of an empty day were adjacent and counted as
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
-- The run must be CURRENT: it ends on the most recent completed day. Without
-- this, any qualifying run anywhere in the window fired, so a warm spell
-- that ended a week ago re-notified every day — the throttle allows one a
-- day — for as long as the run stayed inside the window, up to 30 days after
-- the user recovered.
HAVING COUNT(*) >= CAST($consecutive AS BIGINT)
   AND MAX(day) = date_trunc('day', timezone(CAST($tz AS VARCHAR), NOW())) - INTERVAL 1 DAY
ORDER BY observed_value ${direction === 'greater_than' ? 'DESC' : 'ASC'}
LIMIT 1;`

  return { sql, params: { ...params, consecutive: consecutive ?? 2 } }
}

function buildConsecutive(args: BuildArgs): {
  sql: string
  params: Record<string, string | number>
} {
  const { ts, interval, column, target, compare, consecutive, metricId } = args

  // Cadence in minutes, for slot adjacency below. `sampling_minutes` is the
  // metric's nominal grid; `per_session` metrics have no reading cadence and
  // never reach a reading-cadence rule.
  const meta = metricDefinition(metricId)
  const sampling = meta?.sampling_minutes
  if (typeof sampling !== 'number') {
    throw new RuleValidationError(
      `Rule on ${metricId}: reading-cadence 'consecutive' needs a numeric `
      + `sampling_minutes to define slot adjacency; got '${String(sampling)}'.`,
    )
  }
  const cadenceMinutes = sampling
  const where = whereClause(ts, interval)
  const from = args.from('window')

  if (target.type === 'phase_band')
    return buildConsecutiveBand({ from, where, ts, column, cadenceMinutes, target, consecutive: consecutive as number })

  let thresholdExpr: string
  let params: Record<string, string | number> = {}
  if (target.type === 'absolute') {
    thresholdExpr = THRESHOLD_ABSOLUTE
    params = { threshold_absolute: target.value }
  }
  else if (target.type === 'user_setting') {
    thresholdExpr = USER_SETTING_VALUE
  }
  else if (target.type === 'range') {
    thresholdExpr = RANGE_MIN
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
      ? `NOT (m.${column} BETWEEN ${RANGE_MIN} AND ${RANGE_MAX})`
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
         -- consecutive:3 rule exactly as three adjacent readings did. A 30-minute metric's
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
         -- PARTITION BY breached is load-bearing, not tidiness.
         --
         -- The row number must count BREACHING rows only. Numbering over all
         -- samples and filtering afterwards leaves the key unchanged across a
         -- non-breaching reading: slots 1,2 breach, slot 3 does not, slot 4
         -- breaches -> keys 0,0,0,0, the middle row is filtered out, and the
         -- three survivors share a key and fire a consecutive:3 rule. A
         -- reading that PROVED the user was fine silently became part of a run
         -- against them.
         --
         -- A MISSING slot was already handled by the epoch term; this is the
         -- other half of the same rule, and it was the half still broken.
         CAST(epoch(ts) / 60 / ${cadenceMinutes} AS BIGINT)
           - ROW_NUMBER() OVER (PARTITION BY breached ORDER BY ts) AS run_key
  FROM samples
)
SELECT ${extreme}(value) AS observed_value,
       ANY_VALUE(threshold_value) AS threshold_value
FROM runs
WHERE breached
GROUP BY run_key
HAVING COUNT(*) >= CAST($consecutive AS BIGINT)
ORDER BY observed_value ${compare === 'greater_than' ? 'DESC' : 'ASC'}
LIMIT 1;`

  return { sql, params: { ...params, consecutive: consecutive as number } }
}

/**
 * `phase_band` × `consecutive` — N slot-adjacent readings outside the
 * user's stored band, on either side.
 *
 * The band is resolved ONCE for the window, like `user_setting`'s threshold:
 *
 *   stored  the two rails' `p50` from `user_baseline` — the rows an app's
 *           screen can draw. Both or neither: a user with one learned rail
 *           is still learning, and gets the default rails for both.
 *   scaled  half-width × `$bandScale` about the band's own midpoint, so an
 *           app that scales its displayed band the same way keeps the alert
 *           and the screen in agreement for every sensitivity.
 *
 * Run detection is `buildConsecutive`'s, unchanged: islands keyed on the
 * cadence slot, numbered over breaching rows only.
 *
 * A run reports its reading FURTHEST from the band's midpoint and the rail
 * that reading crossed. Two-sided, so neither MIN nor MAX is "the worst".
 */
function buildConsecutiveBand(args: {
  from: string
  where: string
  ts: string
  column: string
  cadenceMinutes: number
  target: Extract<Target, { type: 'phase_band' }>
  consecutive: number
}): { sql: string, params: Record<string, string | number> } {
  const { from, where, ts, column, cadenceMinutes, target, consecutive } = args
  const params: Record<string, string | number> = {
    bandLoMetric: `${target.band}_lo`,
    bandHiMetric: `${target.band}_hi`,
    baselineDays: target.windowDays,
    consecutive,
  }
  // Bound only when the SQL references them: an unreferenced bind fails the
  // prepare with "Failed to retrieve bind parameter index".
  const hasDefaults = target.defaultLo !== undefined && target.defaultHi !== undefined
  if (hasDefaults) {
    params.bandDefaultLo = target.defaultLo as number
    params.bandDefaultHi = target.defaultHi as number
  }
  // No key: the scale is the rule's own default, bound now. With a key the
  // evaluator binds it per user; the SQL is the same either way.
  if (target.scaleKey === undefined)
    params[BAND_SCALE_PARAM] = (target.defaultScale !== undefined ? target.scales?.[target.defaultScale] : undefined) ?? 1

  /*
   * `rails` is where "still learning" is decided.
   *
   * WITH defaults: the default pair stands in until the user has their
   * own, and the rule fires against it from day one.
   *
   * WITHOUT them: the CASE yields NULL, the `band` CTE yields NULL rails,
   * every `breached` comparison is NULL, and the rule emits nothing. That is
   * the honest state — the screens draw no reference they have not earned
   * (principle 27), and this makes the alert agree with them.
   *
   * Both or neither is enforced by `validatePhaseBand`, so a half-set pair
   * cannot reach here and silently behave like one of the two.
   */
  const railsExpr = hasDefaults
    ? `SELECT CASE WHEN lo IS NOT NULL AND hi IS NOT NULL THEN lo ELSE CAST($bandDefaultLo AS DOUBLE) END AS lo,
         CASE WHEN lo IS NOT NULL AND hi IS NOT NULL THEN hi ELSE CAST($bandDefaultHi AS DOUBLE) END AS hi
  FROM stored`
    : `SELECT lo, hi FROM stored WHERE lo IS NOT NULL AND hi IS NOT NULL`

  const sql = `WITH stored AS (
  SELECT MAX(p50) FILTER (WHERE metric = CAST($bandLoMetric AS VARCHAR)) AS lo,
         MAX(p50) FILTER (WHERE metric = CAST($bandHiMetric AS VARCHAR)) AS hi
  FROM user_baseline
  WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
    AND window_days = CAST($baselineDays AS INTEGER)
),
rails AS (
  ${railsExpr}
),
band AS (
  SELECT (lo + hi) / 2.0 - (hi - lo) / 2.0 * CAST($${BAND_SCALE_PARAM} AS DOUBLE) AS lo,
         (lo + hi) / 2.0 + (hi - lo) / 2.0 * CAST($${BAND_SCALE_PARAM} AS DOUBLE) AS hi
  FROM rails
),
samples AS (
  SELECT m.${ts} AS ts,
         m.${column} AS value,
         (m.${column} < b.lo OR m.${column} > b.hi) AS breached,
         CASE WHEN m.${column} < b.lo THEN b.lo ELSE b.hi END AS threshold_value,
         ABS(m.${column} - (b.lo + b.hi) / 2.0) AS deviation
  ${from}
  CROSS JOIN band b
  ${where}
),
runs AS (
  SELECT ts, value, breached, threshold_value, deviation,
         -- Same islands as buildConsecutive: keyed on the cadence slot, and
         -- numbered over breaching rows only, so neither a missing slot nor
         -- an in-band reading can join two runs.
         CAST(epoch(ts) / 60 / ${cadenceMinutes} AS BIGINT)
           - ROW_NUMBER() OVER (PARTITION BY breached ORDER BY ts) AS run_key
  FROM samples
)
SELECT arg_max(value, deviation) AS observed_value,
       arg_max(threshold_value, deviation) AS threshold_value
FROM runs
WHERE breached
GROUP BY run_key
HAVING COUNT(*) >= CAST($consecutive AS BIGINT)
ORDER BY MAX(deviation) DESC
LIMIT 1;`
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
  const settings = rule.rawSqlSettings
  for (const name of Object.keys(settings ?? {})) {
    if (RESERVED_RAW_PLACEHOLDERS.has(name)) {
      throw new RuleValidationError(
        `Rule ${rule.id}: rawSqlSettings name '${name}' is bound by the engine; choose another.`,
      )
    }
    allowed.add(name)
  }
  for (const p of placeholders) {
    if (!allowed.has(p)) {
      throw new RuleValidationError(
        `Rule ${rule.id}: rawSql placeholder $${p} not declared in rawSqlParams or rawSqlSettings.`,
      )
    }
  }
  const compiled: CompiledRule = {
    ruleId: rule.id,
    metric: rule.metric,
    sql: rawSql,
    params: {},
    description: `rawSql:${rule.metric}`,
  }
  // Only set when used, so a rawSql rule that reads none of these compiles
  // to the same object it always did.
  if (placeholders.includes(TZ_PARAM))
    compiled.needsTimezone = true
  if (placeholders.includes(DEVICE_ID_PARAM))
    compiled.needsDeviceId = true
  if (settings && Object.keys(settings).length > 0)
    compiled.settingParams = settings
  return compiled
}
