import type { AuthLogger } from './types'

/** Default when no logger is configured: auth stays silent rather than using console. */
export const noopLogger: AuthLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/g

/**
 * A log-safe description of a failure. Raw Error objects export as `{}`, and
 * an AuthError is a plain object, so both are reduced to name/code + message.
 * Server messages sometimes echo the login ("no user foo@bar.com"), so
 * anything shaped like an email is redacted.
 */
export function describeError(err: unknown): string {
  let text: string
  if (err instanceof Error) {
    text = `${err.name}: ${err.message}`
  }
  else if (typeof err === 'object' && err !== null && 'message' in err) {
    const { code, message } = err as { code?: unknown, message?: unknown }
    text = code ? `${String(code)}: ${String(message)}` : String(message)
  }
  else {
    text = String(err)
  }
  return text.replace(EMAIL_PATTERN, '[email]')
}

// Opaque, space-free, 16+ chars, with a digit or mixed case: JWTs, bearer
// tokens, Mongo-style user ids — but not error codes like INVALID_CREDENTIALS.
const OPAQUE = /^[\w.~+/=-]{16,}$/
const DIGIT = /\d/
const LOWER = /[a-z]/
const UPPER = /[A-Z]/
const EMAIL_IN_TEXT = /[\w.+-]+@[\w-]+\.[\w.-]+/g

function isTokenLike(value: string): boolean {
  return OPAQUE.test(value) && (DIGIT.test(value) || (LOWER.test(value) && UPPER.test(value)))
}

/**
 * Log-safe form of a free-text string: a value that is itself token-shaped
 * becomes `[redacted]`, and e-mail addresses inside text become `[email]`.
 * A second line of defence; never log a credential on purpose.
 */
export function redactAuthString(value: string): string {
  if (isTokenLike(value))
    return '[redacted]'
  return value.replace(EMAIL_IN_TEXT, '[email]')
}
