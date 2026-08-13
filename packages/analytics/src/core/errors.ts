/**
 * Error taxonomy for @mongrov/analytics core.
 *
 * Full code set frozen in T-16 (Phase 7 — Error taxonomy). This file
 * ships the class and code union so stubs can throw typed errors from
 * day one; downstream phases add more codes without breaking imports.
 */

export type AnalyticsErrorCode =
  | 'engine_open_failed'
  | 'extension_load_failed'
  | 'attach_failed'
  | 'detach_failed'
  | 'token_vendor_failed'
  | 'migration_failed'
  | 'retention_failed'
  | 'family_members_failed'
  | 'query_failed'
  | 'not_attached'
  | 'not_ready'
  | 'not_implemented'

export class AnalyticsError extends Error {
  public readonly code: AnalyticsErrorCode
  public readonly cause?: unknown

  constructor(code: AnalyticsErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'AnalyticsError'
    this.code = code
    this.cause = cause
  }
}

/**
 * Flatten an error and everything that caused it into one log-safe line.
 *
 * Every `catch` in this package used to log `(err as Error).message`. For an
 * `AnalyticsError` that message is the wrapper's own — "execute failed" — and
 * the underlying DuckDB text sits in `.cause`, which was dropped. That is how
 * a rule failure reached the logs with the binder error, the offending column
 * and the SQL position all missing, leaving nothing to diagnose from
 * (zivaone_app#70).
 *
 * Walks the chain with a `seen` set, so a cycle terminates instead of hanging
 * the logger, and renders non-Error causes (strings, DuckDB result objects)
 * via `String()` rather than yielding "[object Object]" for the one frame
 * that usually carries the detail.
 */
export function describeError(err: unknown): string {
  const seen = new Set<unknown>()
  const frames: string[] = []
  let current: unknown = err

  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error) {
      const code = current instanceof AnalyticsError ? ` [${current.code}]` : ''
      frames.push(`${current.name}${code}: ${current.message}`)
      current = (current as { cause?: unknown }).cause
      continue
    }
    frames.push(typeof current === 'string' ? current : String(current))
    break
  }

  return frames.length > 0 ? frames.join(' <- caused by ') : String(err)
}

/**
 * Thrown by unimplemented stubs. Distinct class so tests can assert on
 * "this surface isn't wired yet" without ambiguity against runtime errors.
 */
export class NotImplementedError extends AnalyticsError {
  constructor(symbol: string) {
    super('not_implemented', `${symbol} is not implemented`)
    this.name = 'NotImplementedError'
  }
}
