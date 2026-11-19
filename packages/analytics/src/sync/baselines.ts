/**
 * Per-user baselines: the shared "usual range" rules, tools and screens
 * read, one `user_baseline` row per (brand, family, user, metric, window).
 *
 * Packs supply the definitions (`pack.baselines`: what to compute and the
 * query that computes it); the engine runs them each sync cycle for every
 * family member, writes the rows, announces them once per cycle on
 * `user_baseline:updated`, and logs one summary line.
 */

import type { BaselineDefinition, BaselineProvider } from '../core/packs'
import type { AnalyticsEngine, EventBus } from '../core/types'
import type { SchedulerLogger } from './scheduler'
import { executeBounded } from '../core/bounded-read'
import { describeError } from '../core/errors'
import { tailId } from '../core/logger'
import { packExtensions } from '../core/packs'

/** One computed baseline row, as read back from a definition's query. */
export interface BaselineRow {
  p05: number | null
  p10: number | null
  p50: number | null
  p90: number | null
  p95: number | null
  mean: number | null
  stddev: number | null
  sample_count: number | null
}

export interface BaselineRunContext {
  brand: string
  familyId: string
  userId: string
  /** IANA zone. Day boundaries are local, so this decides the buckets. */
  userTimezone: string
}

export interface BaselineRunResult {
  computed: number
  skipped: number
  failed: number
}

export interface BaselineRunnerConfig {
  analytics: AnalyticsEngine
  eventBus?: EventBus
  logger?: SchedulerLogger
  /** Override every provider's windows (tests). */
  windows?: readonly number[]
  /** Passed to each provider's `definitions` (e.g. a metric subset). */
  options?: Readonly<Record<string, unknown>>
  /** Providers to run; default every registered pack's `baselines`. */
  providers?: readonly BaselineProvider[]
}

/** One row written: which metric and window, from how many days. */
export interface BaselineUpdate {
  metric: string
  windowDays: number
  sampleCount: number | null
}

export interface BaselineRunner {
  /** Run one definition for one window. Returns the rows written. */
  computeDefinition: (
    def: BaselineDefinition,
    windowDays: number,
    ctx: BaselineRunContext,
    onUpdated?: (update: BaselineUpdate) => void,
  ) => Promise<number>
  /** Every definition × window for one user; one announcement, one log line. */
  computeAll: (ctx: BaselineRunContext) => Promise<BaselineRunResult>
  /** The definitions and their windows, in run order. */
  plan: () => Array<{ def: BaselineDefinition, windows: readonly number[] }>
}

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

export function createBaselineRunner(config: BaselineRunnerConfig): BaselineRunner {
  const { analytics, eventBus, logger } = config

  function plan() {
    const providers = config.providers ?? packExtensions<BaselineProvider>('baselines')
    const options = config.options ?? {}
    return providers.flatMap(p =>
      p.definitions(options).map(def => ({ def, windows: config.windows ?? p.windows })))
  }

  /**
   * Called directly, each row is announced as before. `computeAll` instead
   * collects every row and announces ONCE at the end of the cycle
   *: each announcement invalidates every
   * baseline-dependent screen query, and one per metric × window (~39 a
   * cycle) re-ran each of them ~39 times, queued behind the cycle's own SQL
   * on the single connection.
   */
  function announce(ctx: BaselineRunContext, update: BaselineUpdate) {
    eventBus?.emit('user_baseline:updated', {
      userId: ctx.userId,
      ...update,
      computedAt: new Date().toISOString(),
    })
  }

  async function computeDefinition(
    def: BaselineDefinition,
    windowDays: number,
    ctx: BaselineRunContext,
    onUpdated: (update: BaselineUpdate) => void = update => announce(ctx, update),
  ): Promise<number> {
    // mongrov-packages#44 — the bounded form when the engine has every macro
    // and the definition has one, retried as the view form if it throws.
    // Same rows either way.
    const rows = await executeBounded<BaselineRow & { metric?: string }>(
      analytics,
      {
        bounded: analytics.boundedReads === true ? def.sql(windowDays, true) : undefined,
        view: def.sql(windowDays, false)!,
      },
      {
        userId: ctx.userId,
        brand: ctx.brand,
        familyId: ctx.familyId,
        tz: ctx.userTimezone,
        windowDays,
      },
      cause => logger?.warn('baseline.bounded_failed', { metric: def.key, windowDays, error: describeError(cause) }),
    )

    let written = 0
    for (const row of def.rows === 'one' ? rows.slice(0, 1) : rows) {
      // `one`: the query's HAVING filtered it out — fewer than `minDays`
      // distinct days. Not an error: a new user simply has no baseline yet,
      // and consumers render "still learning" rather than a wrong range.
      if (def.rows === 'one' && (row.sample_count === null || row.sample_count < (def.minDays ?? 0)))
        continue
      const metric = def.rows === 'one' ? def.key : String(row.metric)
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
      onUpdated({ metric, windowDays, sampleCount: row.sample_count })
      written += 1
    }
    return written
  }

  return {
    computeDefinition,
    plan,

    async computeAll(ctx) {
      const startedAt = Date.now()
      let computed = 0
      let skipped = 0
      let failed = 0
      // Collected, then logged once at the end of the cycle: a sick warehouse
      // fails every metric × window, and one warn each was dozens of lines a
      // cycle in a 1000-entry export buffer.
      const failures: string[] = []
      let firstError: string | undefined
      const updates: BaselineUpdate[] = []
      const collect = (update: BaselineUpdate) => {
        updates.push(update)
      }

      for (const { def, windows } of plan()) {
        for (const windowDays of windows) {
          try {
            const written = await computeDefinition(def, windowDays, ctx, collect)
            computed += written
            skipped += def.rows === 'one' ? 1 - written : (def.expected ?? written) - written
          }
          catch (err) {
            // One metric's failure must not abort the others.
            failed += 1
            failures.push(`${def.key}/${windowDays}d`)
            firstError ??= describeError(err)
          }
        }
      }

      // One announcement per cycle, and none when nothing was written. Same
      // event; `updates` lists the rows. No subscriber reads the payload —
      // they only invalidate — so the shape is free to carry the list.
      if (updates.length > 0) {
        eventBus?.emit('user_baseline:updated', {
          userId: ctx.userId,
          updates,
          computedAt: new Date().toISOString(),
        })
      }

      const summary = { userId: tailId(ctx.userId), computed, skipped, failed, durationMs: Date.now() - startedAt }
      if (failed > 0) {
        logger?.warn('baseline: compute cycle complete', {
          ...summary,
          failures: failures.slice(0, 10),
          firstError,
        })
      }
      else {
        logger?.info('baseline: compute cycle complete', summary)
      }
      return { computed, skipped, failed }
    },
  }
}
