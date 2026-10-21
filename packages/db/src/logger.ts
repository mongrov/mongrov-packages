/**
 * Logger defaults shared by the factories. The app injects its own logger
 * (`DatabaseConfig.logger`, `ReplicationConfig.logger`, `KVStoreConfig.logger`);
 * these are only what runs when it does not.
 */

import type { DBLogger } from './types'

// React Native global
declare const __DEV__: boolean | undefined

export const noopLogger: DBLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

function isDev(): boolean {
  return typeof __DEV__ !== 'undefined' && !!__DEV__
}

/**
 * Dev-only console fallback for paths whose failures a developer should see
 * even without an injected logger (MMKV falling back to memory). Silent in
 * release, where console output reaches nobody.
 */
export const devConsoleLogger: DBLogger = {
  debug: () => {},
  info: () => {},
  warn: (msg, data) => {
    if (isDev())
      console.warn(msg, data ?? '')
  },
  error: (msg, data) => {
    if (isDev())
      console.error(msg, data ?? '')
  },
}

/** Error → string for log data; a raw Error exports as `{}`. */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
