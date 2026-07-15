/**
 * In-memory token-bucket rate limiter for analytics tools.
 *
 * Three independent buckets per `(toolName, userId)`:
 *   - per-tool-per-minute
 *   - per-tool-per-hour
 *   - per-user-per-minute (across all tools)
 *
 * `check(toolName, userId)` refills every bucket by elapsed time,
 * then attempts to spend one token from all three. If any lacks a
 * token, returns `false` **without** spending from the others.
 * Otherwise deducts one from each and returns `true`.
 *
 * Persistence is out of scope for v0.1.0 — process restart resets
 * buckets. Audit persistence (T-09) handles the durable trail.
 */

import { DEFAULT_RATE_LIMIT, type RateLimitConfig } from './types'

interface BucketState {
  tokens: number
  lastRefillMs: number
  readonly capacity: number
  /** tokens per millisecond = capacity / windowMs */
  readonly refillPerMs: number
}

export interface RateLimiter {
  check: (toolName: string, userId: string) => boolean
}

export interface CreateRateLimiterConfig {
  config?: RateLimitConfig
  clock?: () => number
}

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000

export function createRateLimiter(
  cfg: CreateRateLimiterConfig = {},
): RateLimiter {
  const rl: RateLimitConfig = cfg.config ?? DEFAULT_RATE_LIMIT
  const clock = cfg.clock ?? Date.now

  const perToolMinute = new Map<string, BucketState>()
  const perToolHour = new Map<string, BucketState>()
  const perUserMinute = new Map<string, BucketState>()

  function getOrCreate(
    map: Map<string, BucketState>,
    key: string,
    capacity: number,
    windowMs: number,
    now: number,
  ): BucketState {
    let b = map.get(key)
    if (!b) {
      b = {
        tokens: capacity,
        lastRefillMs: now,
        capacity,
        refillPerMs: capacity / windowMs,
      }
      map.set(key, b)
    }
    return b
  }

  function refill(b: BucketState, now: number): void {
    const elapsed = now - b.lastRefillMs
    if (elapsed <= 0) return
    b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerMs)
    b.lastRefillMs = now
  }

  return {
    check(toolName, userId) {
      const now = clock()
      const toolKey = `${toolName}:${userId}`
      const userKey = userId

      const tm = getOrCreate(
        perToolMinute,
        toolKey,
        rl.perToolPerMinute,
        MS_PER_MINUTE,
        now,
      )
      const th = getOrCreate(
        perToolHour,
        toolKey,
        rl.perToolPerHour,
        MS_PER_HOUR,
        now,
      )
      const um = getOrCreate(
        perUserMinute,
        userKey,
        rl.perUserPerMinute,
        MS_PER_MINUTE,
        now,
      )

      refill(tm, now)
      refill(th, now)
      refill(um, now)

      if (tm.tokens < 1 || th.tokens < 1 || um.tokens < 1) {
        return false
      }

      tm.tokens -= 1
      th.tokens -= 1
      um.tokens -= 1
      return true
    },
  }
}
