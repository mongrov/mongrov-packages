import type { LogEntry } from './types'

/**
 * Keys whose values never belong in a log line, wherever they sit in `data`.
 * Matched case-insensitively against the whole key, so `authToken`,
 * `refresh_token`, `Authorization` and `x-api-key` are all caught.
 */
const SECRET_KEY = /token|authorization|password|passwd|secret|cookie|api[-_]?key|e-?mail/i

// Same shape auth's `describeError` redacts (`auth/src/log.ts`).
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/g

export const REDACTED = '[redacted]'

function redactString(text: string): string {
  return text.replace(EMAIL_PATTERN, '[email]')
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string')
    return redactString(value)
  if (Array.isArray(value))
    return value.map(redactValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    // Strings only: `tokenCount: 3` and `emailVerified: true` carry no secret.
    for (const [key, item] of Object.entries(value))
      out[key] = SECRET_KEY.test(key) && typeof item === 'string' ? REDACTED : redactValue(item)
    return out
  }
  return value
}

/**
 * Core's default `LoggerConfig.redact`: masks the value of any secret-looking
 * key and anything shaped like an email in the message and string values.
 *
 * Runs on the sanitized entry, before any transport sees it, so the ring
 * buffer, the file, the webhook and Sentry all get the same redacted line.
 * Packages pass raw `err.message` strings (server responses echo logins), so
 * this is the one place that can catch them all.
 */
export function defaultRedact(entry: LogEntry): LogEntry {
  return {
    ...entry,
    message: redactString(entry.message),
    data: entry.data === undefined ? undefined : redactValue(entry.data) as Record<string, unknown>,
  }
}
