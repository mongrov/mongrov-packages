/**
 * Effective sampling cadence (Sprint 5 T-41, principle 22).
 *
 * > **Hardware-agnostic cadence.** Chart rendering, rule evaluation windows,
 * > and gap detection derive sampling interval from
 * > `device_config.interval_minutes`, never from constants.
 *
 * The point is that a firmware upgrade changing sampling rate should
 * propagate to charts and rules without an app release. A chart that
 * hard-codes "SpO₂ every 30 minutes" draws the wrong gaps the day a ring
 * ships at 5-minute sampling; a rule whose window was sized against 30
 * minutes silently stops being satisfiable.
 *
 * `metric_metadata.sampling_minutes` remains the fallback — it is what we
 * know before a device has ever reported its schedule, which is every
 * install until the first sync.
 *
 * ## Why this is a runtime read, not a constant
 *
 * `device_config` is SCD-2: one open row per (device, metric), with history.
 * The effective cadence is therefore a property of a *device*, not of the
 * metric, and two family members on one account can legitimately differ.
 *
 * ## Caching
 *
 * Memoized per `(deviceId, metric)`. Ring config changes rarely — it only
 * moves when the user or firmware alters the schedule — so a long TTL is
 * safe, and `invalidate()` covers the case where a sync just wrote a new
 * config row.
 */

import type { MetricId, MetricSamplingMinutes } from './metric_metadata'
import type { AnalyticsEngine, AnalyticsLogger } from './types'
import { describeError } from './errors'
import {
  METRIC_METADATA,

} from './metric_metadata'

/** Default memo lifetime. Ring schedules change on the order of never. */
export const SAMPLING_CACHE_TTL_MS = 10 * 60 * 1000

export interface EffectiveSampling {
  /** Minutes between samples, or `'per_session'` for sleep metrics. */
  minutes: MetricSamplingMinutes
  /** Where the number came from — surfaced for diagnostics and tests. */
  source: 'device_config' | 'metric_metadata'
}

export interface SamplingResolverConfig {
  analytics: Pick<AnalyticsEngine, 'execute'>
  logger?: AnalyticsLogger
  ttlMs?: number
  now?: () => number
}

export interface SamplingResolver {
  /**
   * Effective cadence for a metric on a device.
   *
   * Omitting `deviceId` returns the `metric_metadata` fallback without
   * touching the database — the right behaviour for register-time
   * validation, which runs before any device context exists.
   */
  resolve: (metric: MetricId, deviceId?: string) => Promise<EffectiveSampling>
  /** Drop memoized entries for a device (all metrics), or everything. */
  invalidate: (deviceId?: string) => void
}

interface CacheEntry {
  value: EffectiveSampling
  expiresAt: number
}

interface ConfigRow {
  interval_minutes: number | null
}

/** The fallback, with no I/O. */
export function fallbackSampling(metric: MetricId): EffectiveSampling {
  return {
    minutes: METRIC_METADATA[metric].sampling_minutes,
    source: 'metric_metadata',
  }
}

export function createSamplingResolver(
  config: SamplingResolverConfig,
): SamplingResolver {
  const ttlMs = config.ttlMs ?? SAMPLING_CACHE_TTL_MS
  const now = config.now ?? (() => Date.now())
  const cache = new Map<string, CacheEntry>()

  const keyOf = (deviceId: string, metric: string) => `${deviceId} ${metric}`

  return {
    async resolve(metric, deviceId) {
      // Register-time validation has no device. Returning the fallback here
      // is deliberately permissive: a denser real device only ever makes a
      // rule MORE satisfiable, never less, so validating against the
      // nominal cadence cannot produce a false pass.
      if (!deviceId)
        return fallbackSampling(metric)

      const key = keyOf(deviceId, metric)
      const hit = cache.get(key)
      if (hit && hit.expiresAt > now())
        return hit.value

      let value = fallbackSampling(metric)
      try {
        const rows = await config.analytics.execute<ConfigRow>(
          `SELECT interval_minutes FROM device_config
            WHERE device_id = $deviceId AND metric = $metric
              AND valid_to IS NULL
            ORDER BY valid_from DESC LIMIT 1`,
          { deviceId, metric },
        )
        const interval = rows[0]?.interval_minutes
        if (typeof interval === 'number' && interval > 0) {
          value = { minutes: interval, source: 'device_config' }
        }
      }
      catch (err) {
        // A missing config row is normal (pre-first-sync). A failed read is
        // not, but falling back beats failing a chart render or an
        // evaluation pass over a cadence lookup.
        config.logger?.warn('sampling: device_config read failed, using fallback', {
          metric,
          deviceId,
          err: describeError(err),
        })
      }

      cache.set(key, { value, expiresAt: now() + ttlMs })
      return value
    },

    invalidate(deviceId) {
      if (deviceId === undefined) {
        cache.clear()
        return
      }
      const prefix = `${deviceId} `
      for (const key of cache.keys()) {
        if (key.startsWith(prefix))
          cache.delete(key)
      }
    },
  }
}

/**
 * Minimum window, in minutes, that can hold `consecutive` samples at a
 * given cadence. Used by the rules validator and by gap detection.
 *
 * `per_session` metrics return `null` — "consecutive nights" is bounded by
 * the rule's window in days, not by a sampling interval.
 */
export function minimumWindowMinutes(
  sampling: MetricSamplingMinutes,
  consecutive: number,
): number | null {
  if (sampling === 'per_session')
    return null
  return sampling * Math.max(1, consecutive)
}
