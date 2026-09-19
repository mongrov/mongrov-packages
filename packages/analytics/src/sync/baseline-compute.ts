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

import type { BaselineWindowDays, MetricId } from '../core/metric_metadata'
import type { AnalyticsEngine, EventBus } from '../core/types'
import type { SchedulerLogger } from './scheduler'
import { AnalyticsError } from '../core/errors'
import {
  BASELINE_MIN_DAYS,
  BASELINE_WINDOW_DAYS,
  baselineAggregateFor,

  getBaselineMetricIds,
  METRIC_METADATA,

} from '../core/metric_metadata'
import { readViewFor, STILL_FLOOR } from '../core/reading-quality'
import { minDayReadings } from '../rules/compiler'
import { buildHrPhaseBandsSql } from './hr-phase-bands'

/** One computed baseline row, as read back from the aggregate query. */
interface BaselineRow {
  p05: number | null
  p10: number | null
  p50: number | null
  p90: number | null
  p95: number | null
  mean: number | null
  stddev: number | null
  sample_count: number | null
}

export interface BaselineComputeContext {
  brand: string
  familyId: string
  userId: string
  /** IANA zone. Day boundaries are local, so this decides the buckets. */
  userTimezone: string
}

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

export interface BaselineComputeResult {
  computed: number
  skipped: number
  failed: number
}

/**
 * Build the day-first aggregate SQL for one (metric, window).
 *
 * Exported for snapshot tests — the shape of this query IS the correctness
 * property, so it is worth asserting directly rather than only through
 * results.
 */
export function buildBaselineSql(
  metric: MetricId,
  _windowDays: BaselineWindowDays,
): string {
  const meta = METRIC_METADATA[metric]
  const aggregate = baselineAggregateFor(metric)
  const column = meta.column
  // Baselines read clean readings only (T-25): a spike or an off-wrist
  // temperature must not move "your usual".
  const view = readViewFor(meta.table)

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
        FROM ${view} m
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
    return `
      WITH daily_values AS (
        SELECT date_trunc('day', timezone(CAST($tz AS VARCHAR), timezone('UTC', m.ts))) AS day,
               avg(m.${column}) AS daily_value
        FROM ${view} m
        WHERE m.user_id = $userId AND m.brand = $brand AND m.family_id = $familyId
          AND m.ts > now() - ${scanBind}
          AND m.${column} IS NOT NULL
          AND COALESCE((
            SELECT SUM(a.steps) FROM v_activity a
            WHERE a.user_id = m.user_id AND a.brand = m.brand
              AND a.family_id = m.family_id
              AND a.ts >= m.ts - INTERVAL 15 MINUTE
              AND a.ts <  m.ts + INTERVAL 15 MINUTE
          ), 0) < ${STILL_FLOOR}
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
      FROM ${view}
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

/** UPSERT — recompute replaces the previous row for the same key. */
const UPSERT_SQL = `
INSERT INTO user_baseline (
  brand, family_id, user_id, metric, window_days,
  p05, p10, p50, p90, p95, mean, stddev, sample_count, computed_at
) VALUES (
  $brand, $familyId, $userId, $metric, $windowDays,
  $p05, $p10, $p50, $p90, $p95, $mean, $stddev, $sampleCount, now()
)
ON CONFLICT (brand, family_id, user_id, metric, window_days) DO UPDATE SET
  p05 = excluded.p05,
  p10 = excluded.p10,
  p50 = excluded.p50,
  p90 = excluded.p90,
  p95 = excluded.p95,
  mean = excluded.mean,
  stddev = excluded.stddev,
  sample_count = excluded.sample_count,
  computed_at = excluded.computed_at
`.trim()

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

export function createBaselineComputer(
  config: BaselineComputeConfig,
): BaselineComputer {
  const { analytics, eventBus, logger } = config
  const metrics = config.metrics ?? getBaselineMetricIds()
  const windows = config.windows ?? BASELINE_WINDOW_DAYS

  async function computeOne(
    metric: MetricId,
    windowDays: BaselineWindowDays,
    ctx: BaselineComputeContext,
  ): Promise<boolean> {
    const sql = buildBaselineSql(metric, windowDays)
    const rows = await analytics.execute<BaselineRow>(sql, {
      userId: ctx.userId,
      brand: ctx.brand,
      familyId: ctx.familyId,
      tz: ctx.userTimezone,
      windowDays,
    })

    // HAVING filtered it out — fewer than BASELINE_MIN_DAYS distinct days.
    // Not an error: a new user simply has no baseline yet, and consumers
    // render "still learning" rather than a wrong range.
    const row = rows[0]
    if (!row || row.sample_count === null || row.sample_count < BASELINE_MIN_DAYS) {
      logger?.debug('baseline: insufficient days, row not written', {
        metric,
        windowDays,
        userId: ctx.userId,
        sampleCount: row?.sample_count ?? 0,
        required: BASELINE_MIN_DAYS,
      })
      return false
    }

    await analytics.execute(UPSERT_SQL, {
      brand: ctx.brand,
      familyId: ctx.familyId,
      userId: ctx.userId,
      metric,
      windowDays,
      p05: row.p05,
      p10: row.p10,
      p50: row.p50,
      p90: row.p90,
      p95: row.p95,
      mean: row.mean,
      stddev: row.stddev,
      sampleCount: row.sample_count,
    })

    // Registry queries (`spo2.compareBaseline`, `spo2.baselineMaturity`)
    // invalidate on this.
    eventBus?.emit('user_baseline:updated', {
      userId: ctx.userId,
      metric,
      windowDays,
      sampleCount: row.sample_count,
      computedAt: new Date().toISOString(),
    })
    return true
  }

  /**
   * HR's six phase-band rails (D-H). One query yields every rail with enough
   * days; each is upserted like any other baseline row. A rail short of
   * BASELINE_MIN_DAYS is simply absent from the result — "learning".
   */
  async function computeHrPhaseBands(
    windowDays: BaselineWindowDays,
    ctx: BaselineComputeContext,
  ): Promise<number> {
    const rows = await analytics.execute<BaselineRow & { metric: string }>(buildHrPhaseBandsSql(), {
      userId: ctx.userId,
      brand: ctx.brand,
      familyId: ctx.familyId,
      tz: ctx.userTimezone,
      windowDays,
    })
    for (const row of rows) {
      await analytics.execute(UPSERT_SQL, {
        brand: ctx.brand,
        familyId: ctx.familyId,
        userId: ctx.userId,
        metric: row.metric,
        windowDays,
        p05: row.p05,
        p10: row.p10,
        p50: row.p50,
        p90: row.p90,
        p95: row.p95,
        mean: row.mean,
        stddev: row.stddev,
        sampleCount: row.sample_count,
      })
      eventBus?.emit('user_baseline:updated', {
        userId: ctx.userId,
        metric: row.metric,
        windowDays,
        sampleCount: row.sample_count,
        computedAt: new Date().toISOString(),
      })
    }
    return rows.length
  }

  return {
    computeOne,
    computeHrPhaseBands,

    async computeAll(ctx) {
      let computed = 0
      let skipped = 0
      let failed = 0

      for (const metric of metrics) {
        for (const windowDays of windows) {
          try {
            const written = await computeOne(metric, windowDays, ctx)
            if (written)
              computed += 1
            else skipped += 1
          }
          catch (err) {
            // One metric's failure must not abort the other twenty.
            failed += 1
            logger?.warn('baseline: compute failed', {
              metric,
              windowDays,
              userId: ctx.userId,
              err: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }

      if (config.hrPhaseBands !== false) {
        for (const windowDays of windows) {
          try {
            const written = await computeHrPhaseBands(windowDays, ctx)
            computed += written
            skipped += 6 - written
          }
          catch (err) {
            failed += 1
            logger?.warn('baseline: hr phase bands failed', {
              windowDays,
              userId: ctx.userId,
              err: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }

      logger?.debug('baseline: compute cycle complete', {
        userId: ctx.userId,
        computed,
        skipped,
        failed,
      })
      return { computed, skipped, failed }
    },
  }
}
