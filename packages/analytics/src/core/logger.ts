/**
 * Structured logger plumbing for @mongrov/analytics.
 *
 * Apps supply an `AnalyticsLogger` via `AnalyticsConfig.logger`. When absent
 * we fall back to a no-op sink so callers can `log.debug(...)` unconditionally
 * without null-checks. The library only emits at these levels:
 *
 *   - **debug** — state transitions (hot on attach/detach churn; app can drop)
 *   - **info**  — lifecycle milestones (attached, detached, closed)
 *   - **warn**  — best-effort operations that failed but didn't reject the caller
 *                (retention sweep miss, last-attach persist miss, KV eviction)
 *   - **error** — reserved for callers who want to surface an
 *                 `AnalyticsError` before re-throwing (not used by the library
 *                 today — errors bubble via `throw`)
 *
 * No logs on the hot query path (`execute`, `stream`, `createAppender`) per
 * T-17 AC — apps can enable debug tracing at their integration layer if
 * needed.
 */

import type { AnalyticsLogger } from './types'

/** No-op logger — used when `AnalyticsConfig.logger` is absent. */
export function noopLogger(): AnalyticsLogger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  }
}

/** Resolve the effective logger — provided or no-op. */
export function resolveLogger(provided: AnalyticsLogger | undefined): AnalyticsLogger {
  return provided ?? noopLogger()
}
