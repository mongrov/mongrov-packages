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
 * Thrown by unimplemented stubs. Distinct class so tests can assert on
 * "this surface isn't wired yet" without ambiguity against runtime errors.
 */
export class NotImplementedError extends AnalyticsError {
  constructor(symbol: string) {
    super('not_implemented', `${symbol} is not implemented`)
    this.name = 'NotImplementedError'
  }
}
