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
import {
  BASELINE_MIN_DAYS,
  BASELINE_WINDOW_DAYS,
  baselineAggregateFor,

  getBaselineMetricIds,
  METRIC_METADATA,

} from '../core/metric_metadata'

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
  const view = `v_${meta.table}`

  // DuckDB cannot bind a parameter inside an INTERVAL literal, but it can
  // multiply a static unit interval by a bound integer. Same trick the
  // rules compiler uses.
  const windowBind = `(INTERVAL 1 DAY) * $windowDays`

  let dailySelect: string
  let tsColumn: string
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

  const fn = aggregate === 'sum' ? 'sum' : 'avg'
  tsColumn = 'ts'
  dailySelect
    = `date_trunc('day', timezone($tz, ${tsColumn})) AS day, ${fn}(${column}) AS daily_value`

  return `
    WITH daily_values AS (
      SELECT ${dailySelect}
      FROM ${view}
      WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
        AND ${tsColumn} > now() - ${windowBind}
      GROUP BY day
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
  return `SELECT
      quantile_cont(daily_value, 0.05) AS p05,
      quantile_cont(daily_value, 0.10) AS p10,
      quantile_cont(daily_value, 0.50) AS p50,
      quantile_cont(daily_value, 0.90) AS p90,
      quantile_cont(daily_value, 0.95) AS p95,
      avg(daily_value) AS mean,
      stddev_samp(daily_value) AS stddev,
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

  return {
    computeOne,

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
