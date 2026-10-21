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
