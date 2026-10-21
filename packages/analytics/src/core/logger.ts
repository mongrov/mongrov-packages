/**
 * Structured logger plumbing for @mongrov/analytics.
 *
 * Apps supply an `AnalyticsLogger` via `AnalyticsConfig.logger`. When absent
 * we fall back to a no-op sink so callers can `log.debug(...)` unconditionally
 * without null-checks. The library emits at these levels:
 *
 *   - **debug** — development detail only; never per row / per query
 *   - **info**  — lifecycle checkpoints, once per event (state transitions,
 *                attached, detached, migrations run, retention swept, closed)
 *   - **warn**  — best-effort operations that failed but didn't reject the caller
 *                (retention sweep miss, last-attach persist miss, KV eviction)
 *   - **error** — an operation failed and something is lost or broken (the
 *                engine entering `error`, a macro that failed to create, a
 *                family-members provider failure)
 *
 * No logs on the hot query path (`execute`, `stream`, `createAppender`) per
 * T-17 AC — apps can enable debug tracing at their integration layer if
 * needed. Errors are rendered with `describeError`, never logged raw.
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

/**
 * The last five characters of a device id, for log lines. A ring's id is a
 * BLE address; the tail is enough to tell two rings apart in an export
 * without writing the whole identifier into it.
 */
export function tailId(id: string | undefined): string | undefined {
  return typeof id === 'string' ? id.slice(-5) : id
}
