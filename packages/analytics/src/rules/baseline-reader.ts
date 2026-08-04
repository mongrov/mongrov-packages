/**
 * Baseline reader (Sprint 5 T-24).
 *
 * Rules with `baseline_percent` / `baseline_stddev` targets need the user's
 * usual range. The scheduled job in `analytics-sync/baseline-compute.ts`
 * writes it to `user_baseline` after each sync cycle — but a rule can fire
 * before the first compute has run, so this reader falls back to computing
 * on read.
 *
 * The fallback uses the **same day-first pattern** as the scheduled job.
 * That consistency is the whole point of the module: if the on-read path
 * quantiled raw readings while the scheduled path quantiled daily values,
 * the same rule would fire or not depending purely on whether a sync cycle
 * had happened yet — a heisenbug in a health alert.
 *
 * Results are cached for the duration of one evaluation batch. Within a
 * batch, every rule x user combination reads a consistent baseline;
 * across batches, fresh reads pick up the latest compute.
 */

import { buildBaselineSql } from '../sync/baseline-compute'
import {
  BASELINE_MIN_DAYS,
  type BaselineWindowDays,
  type MetricId,
} from '../core/metric_metadata'
import type { AnalyticsEngine } from '../core/types'
import type { RulesLogger } from './types'

export interface Baseline {
  p05: number | null
  p10: number | null
  p50: number | null
  p90: number | null
  p95: number | null
  mean: number | null
  stddev: number | null
  /** Number of DAYS the baseline is built from, never readings. */
  sampleCount: number
  /** True when this came from an on-read compute, not the stored table. */
  computedOnRead: boolean
}

export interface BaselineReaderConfig {
  analytics: AnalyticsEngine
  logger?: RulesLogger
  /**
   * IANA zone for the on-read fallback's day bucketing. Only the fallback
   * needs it — stored rows were already bucketed at compute time.
   */
  timezone?: string
}

export interface BaselineReader {
  /** Null when the user has fewer than `BASELINE_MIN_DAYS` days of data. */
  getBaseline(
    userId: string,
    metric: MetricId,
    windowDays: BaselineWindowDays,
    ctx: { brand: string, familyId: string },
  ): Promise<Baseline | null>
  /** Drop the per-batch cache. Called at the start of each evaluation pass. */
  resetCache(): void
}

interface StoredRow {
  p05: number | null
  p10: number | null
  p50: number | null
  p90: number | null
  p95: number | null
  mean: number | null
  stddev: number | null
  sample_count: number | null
}

export function createBaselineReader(
  config: BaselineReaderConfig,
): BaselineReader {
  const { analytics, logger } = config
  const cache = new Map<string, Baseline | null>()

  function key(
    userId: string,
    metric: string,
    windowDays: number,
    brand: string,
    familyId: string,
  ): string {
    return `${brand} ${familyId} ${userId} ${metric} ${windowDays}`
  }

  async function readStored(
    userId: string,
    metric: MetricId,
    windowDays: BaselineWindowDays,
    ctx: { brand: string, familyId: string },
  ): Promise<Baseline | null> {
    const rows = await analytics.execute<StoredRow>(
      `SELECT p05, p10, p50, p90, p95, mean, stddev, sample_count
       FROM user_baseline
       WHERE brand = $brand AND family_id = $familyId AND user_id = $userId
         AND metric = $metric AND window_days = $windowDays
       LIMIT 1`,
      {
        brand: ctx.brand,
        familyId: ctx.familyId,
        userId,
        metric,
        windowDays,
      },
    )
    const row = rows[0]
    if (!row || row.sample_count === null || row.sample_count < BASELINE_MIN_DAYS) {
      return null
    }
    return { ...toBaseline(row), computedOnRead: false }
  }

  async function computeOnRead(
    userId: string,
    metric: MetricId,
    windowDays: BaselineWindowDays,
    ctx: { brand: string, familyId: string },
  ): Promise<Baseline | null> {
    // Identical SQL to the scheduled job — imported, not reimplemented, so
    // the two paths cannot drift.
    const rows = await analytics.execute<StoredRow>(
      buildBaselineSql(metric, windowDays),
      {
        userId,
        brand: ctx.brand,
        familyId: ctx.familyId,
        tz: config.timezone ?? 'UTC',
        windowDays,
      },
    )
    const row = rows[0]
    if (!row || row.sample_count === null || row.sample_count < BASELINE_MIN_DAYS) {
      return null
    }
    return { ...toBaseline(row), computedOnRead: true }
  }

  return {
    resetCache() {
      cache.clear()
    },

    async getBaseline(userId, metric, windowDays, ctx) {
      const k = key(userId, metric, windowDays, ctx.brand, ctx.familyId)
      if (cache.has(k)) return cache.get(k) ?? null

      let result: Baseline | null = null
      try {
        result = await readStored(userId, metric, windowDays, ctx)
        if (result === null) {
          result = await computeOnRead(userId, metric, windowDays, ctx)
          if (result !== null) {
            logger?.debug('rules.baseline: stored row absent, computed on read', {
              userId, metric, windowDays,
            })
          }
        }
      }
      catch (err) {
        // A missing baseline is a normal state (new user). A failed read is
        // not, but it must not take down the evaluation pass — the rule
        // simply doesn't fire this cycle.
        logger?.warn('rules.baseline: read failed', {
          userId,
          metric,
          windowDays,
          err: err instanceof Error ? err.message : String(err),
        })
        result = null
      }

      cache.set(k, result)
      return result
    },
  }
}

function toBaseline(row: StoredRow): Omit<Baseline, 'computedOnRead'> {
  return {
    p05: row.p05,
    p10: row.p10,
    p50: row.p50,
    p90: row.p90,
    p95: row.p95,
    mean: row.mean,
    stddev: row.stddev,
    sampleCount: row.sample_count as number,
  }
}
