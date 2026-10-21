/**
 * Logger fallback for when the app injects none.
 *
 * In dev the lines still reach the Metro console; in release they go nowhere
 * (console output is invisible there anyway) — wire `CollabConfig.logger` /
 * the adapter's `logger` option to the app logger to keep them.
 */

import type { CollabLogger } from './types'

function noop(): void {}

export const noopCollabLogger: CollabLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
}

function isDev(): boolean {
  // `__DEV__` is a React Native global; this package has no RN types.
  return (globalThis as { __DEV__?: unknown }).__DEV__ === true
}

// The logger's own dev fallback: the one place console output is allowed.
const devConsoleLogger: CollabLogger = {
  debug: (msg, data) => console.debug(msg, data ?? ''),
  info: (msg, data) => console.log(msg, data ?? ''),
  warn: (msg, data) => console.warn(msg, data ?? ''),
  error: (msg, data) => console.error(msg, data ?? ''),
}

export function resolveCollabLogger(logger?: CollabLogger): CollabLogger {
  if (logger)
    return logger
  return isDev() ? devConsoleLogger : noopCollabLogger
}
