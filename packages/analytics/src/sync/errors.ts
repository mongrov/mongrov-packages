/**
 * SyncError taxonomy (design.md §Errors).
 *
 * Codes:
 *   - `flush_failed` — Appender write failed (all retries exhausted or fatal)
 *   - `push_failed` — R2 push failed (all retries exhausted)
 *   - `fetch_failed` — R2 fetch failed
 *   - `overflow_dropped` — drop-newest policy discarded a batch
 *   - `token_expired` — 401 from R2 after token refresh
 *   - `constraint_not_met` — scheduler skipped a cycle (battery / network)
 *   - `mapper_failed` — firmware mapper raised
 */

export type SyncErrorCode
  = | 'flush_failed'
    | 'push_failed'
    | 'fetch_failed'
    | 'overflow_dropped'
    | 'token_expired'
    | 'constraint_not_met'
    | 'mapper_failed'

export class SyncError extends Error {
  readonly code: SyncErrorCode
  readonly cause: unknown

  constructor(code: SyncErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'SyncError'
    this.code = code
    this.cause = cause
  }
}
