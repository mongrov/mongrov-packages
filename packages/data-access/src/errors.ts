/**
 * Error taxonomy for @mongrov/data-access.
 *
 * Full code set fills in as later phases land. This file ships the class
 * plus the codes stubs need on day one.
 */

export type DataAccessErrorCode =
  | 'authorization_denied'
  | 'engine_missing'
  | 'zod_parse_failed'
  | 'define_config_invalid'
  | 'invalid_pattern'
  | 'not_implemented'

export class DataAccessError extends Error {
  public readonly code: DataAccessErrorCode
  public readonly cause?: unknown

  constructor(code: DataAccessErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'DataAccessError'
    this.code = code
    this.cause = cause
  }
}

/**
 * Thrown when authorization hook rejects a query or mutation.
 * See data-access/spec.md §Authorization.
 */
export class AuthorizationError extends DataAccessError {
  constructor(message: string, cause?: unknown) {
    super('authorization_denied', message, cause)
    this.name = 'AuthorizationError'
  }
}

/**
 * Thrown by unimplemented stubs. Distinct class so tests can assert on
 * "this surface isn't wired yet" without ambiguity against runtime errors.
 */
export class NotImplementedError extends DataAccessError {
  constructor(symbol: string) {
    super(
      'not_implemented',
      `${symbol} is not implemented in @mongrov/data-access@0.1.0-alpha.0`
    )
    this.name = 'NotImplementedError'
  }
}
