import { NotImplementedError } from './errors'
import type { AnalyticsState, Insight } from './types'

/**
 * React hooks over the analytics engine. Stubs in T-02; real wiring via
 * `useSyncExternalStore` on `engine.subscribe()` lands in Phase 5 (T-11/12/13).
 *
 * React is an optional peer, so these stubs deliberately do not import
 * React — they simply throw NotImplementedError. This keeps @mongrov/analytics
 * consumable from non-React runtimes (Node CLI, background workers) until
 * the hooks are actually implemented.
 */

// T-11 — public shape per analytics-core/spec.md §Hooks
export function useAnalytics(): {
  state: AnalyticsState
  isReady: boolean
  isAttached: boolean
  error: Error | null
} {
  throw new NotImplementedError('useAnalytics')
}

// T-12 — public shape per analytics-core/spec.md §Hooks
export function useTimeseries<T = unknown>(
  _key: string | undefined,
  _sql: string,
  _params?: Record<string, unknown>
): {
  data: T[] | undefined
  loading: boolean
  error: Error | null
  refetch: () => Promise<void>
} {
  throw new NotImplementedError('useTimeseries')
}

// T-13 — public shape per analytics-core/spec.md §Hooks
export function useInsight(_id: string): {
  insight: Insight | undefined
  loading: boolean
} {
  throw new NotImplementedError('useInsight')
}
