/**
 * KV-backed throttle store for rule fires.
 *
 * Two keys per (rule, user):
 *   - `analytics:rules:throttle:{ruleId}:{userId}:last` → ISO date string
 *   - `analytics:rules:throttle:{ruleId}:{userId}:count:{yyyy-mm-dd}` → number
 *
 * Order of checks: min-gap first, then daily cap. Stale daily-count
 * entries (from earlier days) are best-effort deleted on next-day reads.
 *
 * All time reads go through an injected `clock: () => Date` so tests can
 * pin the wall clock. Production defaults to `() => new Date()`.
 */

import type { KVStore } from '../core/types'
import type { Throttle } from './schema'
import type { Clock, RulesLogger } from './types'

const KEY_PREFIX = 'analytics:rules:throttle:'

function lastKey(ruleId: string, userId: string): string {
  return `${KEY_PREFIX}${ruleId}:${userId}:last`
}

function countKey(ruleId: string, userId: string, ymd: string): string {
  return `${KEY_PREFIX}${ruleId}:${userId}:count:${ymd}`
}

/** yyyy-mm-dd in UTC. */
function ymdOf(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export interface ThrottleStore {
  isThrottled: (ruleId: string, userId: string, throttle: Throttle) => Promise<boolean>
  recordFire: (ruleId: string, userId: string) => Promise<void>
}

export interface CreateThrottleConfig {
  storage: KVStore
  clock?: Clock
  logger?: RulesLogger
}

export function createThrottleStore({
  storage,
  clock = () => new Date(),
  logger,
}: CreateThrottleConfig): ThrottleStore {
  return {
    async isThrottled(ruleId, userId, throttle) {
      const now = clock()
      const ymd = ymdOf(now)

      // Min-gap check.
      const lastRaw = await storage.get<string>(lastKey(ruleId, userId))
      if (lastRaw) {
        const last = new Date(lastRaw)
        const gapMs = now.getTime() - last.getTime()
        const minGapMs = throttle.minGapMinutes * 60 * 1000
        if (gapMs < minGapMs) {
          logger?.debug('rules.throttle: gap', {
            ruleId,
            userId,
            gapMs,
            minGapMs,
          })
          return true
        }
        // Purge stale daily-count keys from prior days (best-effort).
        const lastYmd = ymdOf(last)
        if (lastYmd !== ymd) {
          await storage.delete(countKey(ruleId, userId, lastYmd))
        }
      }

      // Daily cap check.
      const count = (await storage.get<number>(countKey(ruleId, userId, ymd))) ?? 0
      if (count >= throttle.maxPerDay) {
        logger?.debug('rules.throttle: daily cap', {
          ruleId,
          userId,
          count,
          maxPerDay: throttle.maxPerDay,
        })
        return true
      }

      return false
    },

    async recordFire(ruleId, userId) {
      const now = clock()
      const ymd = ymdOf(now)
      await storage.set(lastKey(ruleId, userId), now.toISOString())
      const count = (await storage.get<number>(countKey(ruleId, userId, ymd))) ?? 0
      await storage.set(countKey(ruleId, userId, ymd), count + 1)
    },
  }
}
