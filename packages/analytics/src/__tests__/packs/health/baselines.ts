/**
 * Day-first baseline compute (Sprint 5 §7 / T-13 / T-14, principle 27).
 *
 * Populates `user_baseline`, the shared "usual range" that rules, AI tools,
 * and screens all read. One row per (brand, family, user, metric, window).
 *
 * ## Why day-first
 *
 * The naive implementation quantiles raw readings. That is wrong, and
 * wrong in a way that looks plausible: SpO₂ sampled every 30 minutes dips
 * during deep sleep on most nights, so a raw p10 across 30 days reports the
 * dip* (~87%) as the bottom of the user's usual range. It isn't — it's a
 * normal nightly event that happens every day. The user's day-to-day
 * variation is much narrower.
 *
 * So: collapse each local day to ONE value, then quantile across days. A
 * fixture of `95, 95, 87, 95, 95` repeated for 30 days gives p10 ≈ 92.6
 * day-first versus 87 raw — and 92.6 is the honest answer.
 *
 * This is also why `sample_count` counts DAYS. Fifteen days of 30-minute
 * sampling is 720 readings but still only 15 days of evidence, and must not
 * populate a baseline.
 */

import type { BaselineDefinition, BaselineProvider } from '../../../core/packs'
import type { AnalyticsEngine, EventBus } from '../../../core/types'
import type { BaselineRunContext, BaselineRunResult } from '../../../sync/baselines'
import type { SchedulerLogger } from '../../../sync/scheduler'
import type { BaselineWindowDays, MetricId } from './metrics'
import { boundedRelation, daysInterval, SPARE_DAYS } from '../../../core/bounded-read'
import { AnalyticsError } from '../../../core/errors'
import { minDayReadings } from '../../../rules/compiler'
import { createBaselineRunner } from '../../../sync/baselines'
import { buildHrPhaseBandsSql } from './hr-phase-bands'
import {
  BASELINE_MIN_DAYS,
  BASELINE_WINDOW_DAYS,
  baselineAggregateFor,

  getBaselineMetricIds,
  METRIC_METADATA,

} from './metrics'
import { isQualityTable, readViewFor, STILL_FLOOR, STILL_WINDOW_MINUTES } from './reading-quality'

export type BaselineComputeContext = BaselineRunContext

export interface BaselineComputeConfig {
  analytics: AnalyticsEngine
  eventBus?: EventBus
  logger?: SchedulerLogger
  /** Override for tests. Defaults to every metric declaring an aggregate. */
  metrics?: readonly MetricId[]
  /** Override for tests. Defaults to 7 / 30 / 90. */
  windows?: readonly BaselineWindowDays[]
  /**
   * Also write heart rate's six phase-band rails (`hr-phase-bands.ts`).
   * Default true; tests of the per-metric path turn it off.
   */
  hrPhaseBands?: boolean
}

export type BaselineComputeResult = BaselineRunResult

/**
 * Whether `metric`'s baseline has a bounded form (mongrov-packages#44).
 *
 * True when it reads a vital's clean view, which is a window function over
 * the tenant's whole history and has a `_between` macro. Steps and sleep read
 * plain union views with no macro and no history-wide window, so they have
 * nothing to bound.
 */
export function baselineHasBoundedForm(metric: MetricId): boolean {
  const aggregate = baselineAggregateFor(metric)
  return aggregate !== undefined && aggregate !== 'session' && isQualityTable(METRIC_METADATA[metric].table)
}

/**
 * Build the day-first aggregate SQL for one (metric, window).
 *
 * Exported for snapshot tests — the shape of this query IS the correctness
 * property, so it is worth asserting directly rather than only through
 * results.
 *
 * ## `bounded` (mongrov-packages#44)
 *
 * Reads the clean view's `_between` macro over `now - (scan + spare day)`
 * instead of the view, so a 7-day baseline stops paying for every reading the
 * ring ever took. Each path keeps its own `ts` filter unchanged; the bound
 * only has to be a superset of what that filter admits, and the spare day
 * (bounded-read) covers a lost session-zone pin. The macro returns exactly
 * the view's rows in its window (`bounded-quality-equivalence.test.ts`), with
 * its own pads for the flags that look at neighbours (spike, warm-up onset).
 * `computeOne` runs this form only when `analytics.boundedReads` is set, and
 * retries the view form if it throws (`executeBounded`). Ignored for metrics
 * without a bounded form (`baselineHasBoundedForm`).
 */
export function buildBaselineSql(
  metric: MetricId,
  _windowDays: BaselineWindowDays,
  opts: { bounded?: boolean } = {},
): string {
  const meta = METRIC_METADATA[metric]
  const aggregate = baselineAggregateFor(metric)
  const column = meta.column
  // Baselines read clean readings only (T-25): a spike or an off-wrist
  // temperature must not move "your usual".
  const view = readViewFor(meta.table)
  const bounded = opts.bounded === true && baselineHasBoundedForm(metric)
  /** The clean relation, bounded `scanDays` (a SQL BIGINT expr) + the spare day back. */
  const relation = (scanDays: string): string => bounded
    ? boundedRelation(view, { back: daysInterval(`(${scanDays} + ${SPARE_DAYS})`) })
    : view

  // DuckDB cannot bind a parameter inside an INTERVAL literal, but it can
  // multiply a static unit interval by a bound integer. Same trick the
  // rules compiler uses — including, until now, the same defect.
  //
  // The CAST is not cosmetic (zivaone_app#72). react-native-duckdb prepares
  // with no values and executes with them, so a parameter's type has to
  // resolve from SQL context at prepare time; with none it stays UNKNOWN and
  // the bind throws ParameterNotResolvedException. Interval multiplication
  // has no INTEGER overload, so this site has no context to resolve from.
  //
  // BIGINT, not INTEGER: `CAST($p AS INTEGER)` still fails here because
  // INTEGER widens ambiguously against the interval overloads.
  //
  // This does not reproduce on node/Python DuckDB, which hand values to the
  // binder and therefore always have a type. Only a device build shows it.
  const windowBind = `(INTERVAL 1 DAY) * CAST($windowDays AS BIGINT)`

  // A day-bucketed baseline reads COMPLETE LOCAL DAYS: the $windowDays days
  // before today, each whole. `ts > now() - N days` alone holds two partial
  // days — today, still accumulating, and the oldest day, cut at the current
  // time of day — and each counted as a full day: a 500-step morning in a
  // summed baseline, a two-reading day in an averaged one, and one more day
  // toward the BASELINE_MIN_DAYS gate than the user had. The rules' day
  // cadence already excludes today; this makes the baseline agree.
  //
  // The WHERE keeps its `now() -` prefilter (one extra day of slack for the
  // zone offset) so the scan still prunes; the HAVING decides the days.
  const scanBind = `(INTERVAL 1 DAY) * (CAST($windowDays AS BIGINT) + 1)`
  const localToday = `date_trunc('day', timezone(CAST($tz AS VARCHAR), now()))`
  const completeDays = `day >= ${localToday} - ${windowBind} AND day < ${localToday}`

  let dailySelect: string
  let tsColumn: string

  if (aggregate === 'nightly_min') {
    // D-G: "resting heart rate" is the NIGHTLY LOW — the minimum reading
    // inside the night's sleep session(s), attributed to the local day the
    // sleep ENDED in.
    //
    // Two operations that compose, and both matter:
    //   MIN within a night   — each night contributes its own low
    //   p50 across nights    — "usual resting" is the median of those lows
    //
    // The quantile half is the standard compute below, NOT special-cased
    // here: resting_hr is an ordinary day-first metric whose daily value
    // happens to be a minimum. That is the reason to trust it.
    //
    // "Usual resting" is therefore p50 of per-night minima, NEVER a minimum
    // across nights. A min-across-nights would be the best night in 30 — a
    // floor, not a usual. Every ordinary night would sit above it, the drift
    // card would show a permanent elevation, and the 4-bpm creep it exists to
    // catch would be invisible against a reference already below typical.
    //
    // Day key is `ts_end`'s local day, not the mapper's `night_of`. The two
    // differ for a nap or a pre-midnight sleep, and the ruling is explicit
    // that the day the sleep ended in is the one that owns the value.
    return `
      WITH daily_values AS (
        SELECT date_trunc('day', timezone(CAST($tz AS VARCHAR), timezone('UTC', s.ts_end))) AS day,
               MIN(m.${column}) AS daily_value
        FROM ${relation('CAST($windowDays AS BIGINT)')} m
        JOIN v_sleep_session s
          ON s.user_id = m.user_id AND s.brand = m.brand AND s.family_id = m.family_id
         AND m.ts >= s.ts_start AND m.ts < s.ts_end
        WHERE m.user_id = $userId AND m.brand = $brand AND m.family_id = $familyId
          AND m.ts > now() - ${windowBind}
          AND m.${column} IS NOT NULL
        GROUP BY 1
      )
      ${quantileSelect()}
    `.trim()
  }

  if (aggregate === 'resting_avg') {
    // D-G: the DAYTIME still-time mean — the mean of readings taken while the
    // user was not moving. This is NOT resting heart rate.
    //
    // `resting_hr` (nightly_min) answers "how low does your heart settle
    // overnight". This answers "was your rate higher than usual while you were
    // still today", which is the question the cross-vital factor on the
    // Temperature and HRV screens asks. Two metrics, deliberately named apart
    // so they can never be confused again.
    //
    // "Still" is the same test `hr.restingVsUsual` uses and the same one
    // `active` uses on every vital screen: fewer than STILL_FLOOR steps
    // across the +/-15 minute window. Keeping one definition is what makes
    // "active" and "resting" complementary rather than two independent
    // guesses.
    //
    // It was `steps > 0`, which is not a movement test — a worn ring reports
    // a few steps most waking minutes, so nearly every daytime reading was
    // excluded and this mean was computed from whatever minutes happened to
    // record a literal zero. See STILL_STEPS_PER_HOUR in core/reading-quality.
    //
    // KNOWN DIVERGENCE: the rules compiler's `resting` CONTEXT still gates on
    // `steps > 0` (rules/compiler.ts). An ANTI JOIN tests row existence and
    // cannot express a summed floor, so aligning it needs a design change to
    // a public export rather than a substitution. Until then a reading can be
    // `still` for this baseline and the charts, yet `not resting` for a rule
    // that alerts on it.
    //
    // ## Steps in the window: two lookups, not a scan (zivaone_app#460 P15)
    //
    // This was a correlated `SUM(steps) FROM v_activity` over `[ts - 15,
    // ts + 15)` per reading — the shape zivaone_app#126 measured at ~33 s at
    // 180 days, run here once per window (7 / 30 / 90) per cycle. It is now
    // the subtraction `v_motion` and `hr-phase-bands.ts` use: a running step
    // total, `mn` = latest row strictly before the window closes, `mp` =
    // latest strictly before it opens, and `cum(mn) - cum(mp)` is exactly the
    // steps in the half-open window. See `motionJoin` in core/reading-quality.
    //
    // Two deliberate choices, both to keep the result IDENTICAL to the
    // correlated sum (`resting-gated-still-equivalence.test.ts` runs both):
    //
    //   - TENANT-WIDE `cum_steps`, no `device_id` match. The correlated sum
    //     counted every ring's steps; the clean views' `still` counts only
    //     the reading's own ring (zivaone_app#366). Moving this baseline to
    //     the device-scoped definition is a behaviour change, not a perf fix,
    //     and is left for its own decision.
    //   - A BOUNDED running total, inlined rather than `v_motion` (whose
    //     window spans the whole activity history) or the `v_motion_between`
    //     macro. Readers that use the macros (the phase bands below, rules,
    //     tools) gate on `analytics.boundedReads` and keep a view-form
    //     fallback (`executeBounded`, mongrov-packages#44); this query has no
    //     view form to fall back to that is not the full-history scan, so it
    //     stays self-contained rather than depending on a macro whose
    //     creation is non-fatal at attach. The slice starts STILL_WINDOW_MINUTES before the
    //     earliest reading the scan admits, which is exact by the same
    //     argument as `v_motion_between`: rows before `mp` cancel, and when
    //     the slice has no `mp` every row up to `mn` is inside the window.
    //     The pad is REQUIRED, not belt-and-braces: the scan starts
    //     `windowDays + 1` days of elapsed time back, but the HAVING keeps
    //     whole LOCAL days, and across a DST fall-back a local day is 25 h.
    //     E.g. Los Angeles, 30-day window, run at 23:30 PST with fall-back
    //     inside the window: the scan starts at 00:30 PDT on the oldest KEPT
    //     day, so readings in its first 15 minutes have windows that reach
    //     before the scan start — without the pad they would lose those steps.
    //
    // One row per instant (GROUP BY ts): two rings logging the same minute
    // become one row carrying both rings' steps. With ties left in, the
    // answer would rest on the window frame (RANGE gives tied rows the same
    // total, ROWS would not) and on which tied row DuckDB's ASOF happens to
    // return — measured to follow insertion order. Collapsed, neither exists.
    //
    // A reading with no activity near it gets 0 either way (both lookups NULL
    // or the same row), matching the old `COALESCE(SUM, 0)`.
    return `
      WITH motion AS (
        SELECT user_id, brand, family_id, ts,
               SUM(SUM(steps)) OVER (PARTITION BY user_id, brand, family_id ORDER BY ts) AS cum_steps
        FROM v_activity
        WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
          AND steps IS NOT NULL
          AND ts >= now() - ${scanBind} - INTERVAL ${STILL_WINDOW_MINUTES} MINUTE
        GROUP BY user_id, brand, family_id, ts
      ),
      daily_values AS (
        SELECT date_trunc('day', timezone(CAST($tz AS VARCHAR), timezone('UTC', m.ts))) AS day,
               avg(m.${column}) AS daily_value
        FROM ${relation('CAST($windowDays AS BIGINT) + 1')} m
        ASOF LEFT JOIN motion mp
          ON mp.user_id = m.user_id AND mp.brand = m.brand AND mp.family_id = m.family_id
         AND m.ts - INTERVAL ${STILL_WINDOW_MINUTES} MINUTE > mp.ts
        ASOF LEFT JOIN motion mn
          ON mn.user_id = m.user_id AND mn.brand = m.brand AND mn.family_id = m.family_id
         AND m.ts + INTERVAL ${STILL_WINDOW_MINUTES} MINUTE > mn.ts
        WHERE m.user_id = $userId AND m.brand = $brand AND m.family_id = $familyId
          AND m.ts > now() - ${scanBind}
          AND m.${column} IS NOT NULL
          AND COALESCE(mn.cum_steps, 0) - COALESCE(mp.cum_steps, 0) < ${STILL_FLOOR}
        GROUP BY 1
        HAVING ${completeDays}
      )
      ${quantileSelect()}
    `.trim()
  }

  if (aggregate === 'session') {
    // Sleep is already attributed to a local night by the mapper's 6pm-6pm
    // rule, so `night_of` is a better day key than re-deriving one from a
    // timestamp — it is DST-correct by construction.
    //
    // NOTE: this groups, where the Sprint 5 design sketch skipped the
    // GROUP BY for session metrics. Skipping it makes `count(*)` count
    // SESSIONS, so a user with two sessions a night would satisfy the
    // 20-day minimum after 10 nights — contradicting T-14. Summing per
    // night also gives the right daily value: total sleep that night.
    dailySelect = `night_of AS day, sum(${column}) AS daily_value`
    tsColumn = 'ts_start'
    return `
      WITH daily_values AS (
        SELECT ${dailySelect}
        FROM ${view}
        WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
          AND ${tsColumn} > now() - ${windowBind}
        GROUP BY night_of
      )
      ${quantileSelect()}
    `.trim()
  }

  // Fail loudly on an aggregate this dispatch does not implement.
  //
  // This was `aggregate === 'sum' ? 'sum' : 'avg'`, so ANY unrecognised value
  // silently became `avg`. Declaring a metric with a new aggregate — say
  // `nightly_min` — and forgetting the dispatch case would compute a mean of
  // every reading and store it as the nightly low: wrong, silent, and
  // indistinguishable from a correct baseline downstream.
  //
  // `session` never reaches here; it returns from the branch above.
  if (aggregate !== 'sum' && aggregate !== 'avg') {
    // `session` and `nightly_min` returned above.
    throw new AnalyticsError(
      'not_implemented',
      `baselineDailyAggregate '${aggregate}' has no dispatch case. Add one `
      + `rather than letting it fall through to avg.`,
    )
  }
  const fn = aggregate === 'sum' ? 'sum' : 'avg'
  tsColumn = 'ts'
  // Two separate defects fixed here (zivaone_app#73); either alone is wrong.
  //
  // 1. `CAST($tz AS VARCHAR)` — the untyped-parameter defect above.
  //
  // 2. The nested `timezone('UTC', ts)` — direction. Every `ts` column is
  //    `TIMESTAMP NOT NULL` (naive UTC), and DuckDB picks the `timezone()`
  //    overload from its SECOND argument:
  //      timezone(tz, TIMESTAMPTZ) -> converts into that zone   (wanted)
  //      timezone(tz, TIMESTAMP)   -> LABELS the naive value    (what we had)
  //    So a 02:00 UTC reading was labelled 02:00-07:00 rather than converted
  //    to 19:00 the previous day, attributing evening readings to the next
  //    local day and grouping the daily aggregates on the wrong boundary.
  //    Inner `timezone('UTC', ts)` makes it a TIMESTAMPTZ first.
  //
  // This one changes the percentiles `user_baseline` stores, not merely
  // whether the query runs — casting alone would bind fine and still bucket
  // wrong. `timezone($tz, now())` elsewhere is correct as-is: `now()` is
  // already TIMESTAMPTZ.
  dailySelect
    = `date_trunc('day', timezone(CAST($tz AS VARCHAR), timezone('UTC', ${tsColumn}))) AS day, ${fn}(${column}) AS daily_value`

  // An averaged day also needs enough readings to BE a day: the floor the
  // rules' day cadence applies (minDayReadings, 25% of the metric's slots),
  // so a day the rules and the trend charts call absent is absent here too.
  // A summed day takes no floor. Steps are logged per minute on some rings
  // and only while moving on others, so a row count says nothing about
  // whether a sum is whole — the complete-days bound is what does.
  const sampling = meta.sampling_minutes
  const dayFloor = fn === 'avg' && typeof sampling === 'number'
    ? ` AND count(${column}) >= ${minDayReadings(sampling)}`
    : ''

  return `
    WITH daily_values AS (
      SELECT ${dailySelect}
      FROM ${relation('CAST($windowDays AS BIGINT) + 1')}
      WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
        AND ${tsColumn} > now() - ${scanBind}
      GROUP BY day
      HAVING ${completeDays}${dayFloor}
    )
    ${quantileSelect()}
  `.trim()
}

/**
 * The quantile pass, identical across aggregate types.
 *
 * `HAVING count(*) >= n` rather than `HAVING sample_count >= n`: the alias
 * is not guaranteed visible in HAVING across DuckDB versions, and getting
 * this wrong would silently write under-evidenced baselines.
 */
function quantileSelect(): string {
  // DuckDB will not implicitly narrow HUGEINT to DOUBLE.
  //
  // `daily_value` for the `session` aggregate is `sum(total_minutes)` over an
  // INTEGER column, which DuckDB sums into HUGEINT. That conversion is lossy,
  // so it is never applied implicitly, and quantile_cont / avg / stddev_samp
  // all reject the argument outright. On react-native-duckdb it surfaces as an
  // opaque `Unknown duckdb::InvalidInputException error` — no column name, no
  // function name — so the sleep baseline has never computed on any version.
  //
  // Cast once, here, where every aggregate funnels through: casting at the
  // call sites instead is six chances to miss one, and a missed one fails only
  // for the metric whose column happens to be integral.
  const v = 'CAST(daily_value AS DOUBLE)'
  return `SELECT
      quantile_cont(${v}, 0.05) AS p05,
      quantile_cont(${v}, 0.10) AS p10,
      quantile_cont(${v}, 0.50) AS p50,
      quantile_cont(${v}, 0.90) AS p90,
      quantile_cont(${v}, 0.95) AS p95,
      avg(${v}) AS mean,
      stddev_samp(${v}) AS stddev,
      count(*) AS sample_count
    FROM daily_values
    HAVING count(*) >= ${BASELINE_MIN_DAYS}`
}

// -------------------- the pack's baselines --------------------

/** HR's six phase-band rails (D-H), computed as one definition. */
const HR_PHASE_BANDS: BaselineDefinition = {
  key: 'hr_phase_bands',
  rows: 'many',
  expected: 6,
  sql: (_windowDays, bounded) => buildHrPhaseBandsSql(bounded ? { bounded: true } : {}),
}

/** One metric's day-first baseline. */
function metricDefinition(metric: MetricId): BaselineDefinition {
  return {
    key: metric,
    rows: 'one',
    minDays: BASELINE_MIN_DAYS,
    sql: (windowDays, bounded) => bounded
      ? (baselineHasBoundedForm(metric) ? buildBaselineSql(metric, windowDays as BaselineWindowDays, { bounded: true }) : undefined)
      : buildBaselineSql(metric, windowDays as BaselineWindowDays),
  }
}

/**
 * The health pack's baselines: every metric declaring a baseline aggregate,
 * then HR's phase-band rails, over 7 / 30 / 90 days. Options: `metrics`
 * (a subset, in that order) and `hrPhaseBands: false`.
 */
export const healthBaselines: BaselineProvider = {
  windows: BASELINE_WINDOW_DAYS,
  definitions(options) {
    const metrics = (options.metrics as readonly MetricId[] | undefined) ?? getBaselineMetricIds()
    return [
      ...metrics.map(metricDefinition),
      ...(options.hrPhaseBands === false ? [] : [HR_PHASE_BANDS]),
    ]
  },
}

// -------------------- the pre-pack computer --------------------

export interface BaselineComputer {
  /** Compute one (metric, window). Returns true when a row was written. */
  computeOne: (
    metric: MetricId,
    windowDays: BaselineWindowDays,
    ctx: BaselineComputeContext,
  ) => Promise<boolean>
  /** Compute every configured metric x window for one user. */
  computeAll: (ctx: BaselineComputeContext) => Promise<BaselineComputeResult>
  /** Write HR's phase-band rails for one window. Returns the rails written. */
  computeHrPhaseBands: (windowDays: BaselineWindowDays, ctx: BaselineComputeContext) => Promise<number>
}

/**
 * The health baselines on the engine's runner, as the package exposed them
 * before packs. The sync manager runs every registered pack's baselines
 * itself; this is for callers that compute them directly.
 */
export function createBaselineComputer(
  config: BaselineComputeConfig,
): BaselineComputer {
  const runner = createBaselineRunner({
    analytics: config.analytics,
    eventBus: config.eventBus,
    logger: config.logger,
    windows: config.windows,
    options: { metrics: config.metrics, hrPhaseBands: config.hrPhaseBands },
    providers: [healthBaselines],
  })
  return {
    computeOne: async (metric, windowDays, ctx) =>
      (await runner.computeDefinition(metricDefinition(metric), windowDays, ctx)) > 0,
    computeHrPhaseBands: (windowDays, ctx) => runner.computeDefinition(HR_PHASE_BANDS, windowDays, ctx),
    computeAll: ctx => runner.computeAll(ctx),
  }
}
