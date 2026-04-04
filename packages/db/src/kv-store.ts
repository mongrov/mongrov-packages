/**
 * KVStore factory
 *
 * Creates a unified async key-value store backed by either:
 * - MMKV (default) — fast, for preferences/caches
 * - SecureStore (secure: true) — for tokens/secrets
 */

import type { KVStore, KVStoreConfig } from './types'
import { MMKVBackend } from './kv-backends/mmkv-backend'
import { SecureBackend } from './kv-backends/secure-backend'

/**
 * Create a KVStore instance.
 *
 * @example
 * ```typescript
 * // Default MMKV store for preferences
 * const prefs = createKVStore()
 * await prefs.set('theme', 'dark')
 *
 * // Isolated MMKV instance
 * const cache = createKVStore({ instanceId: 'api-cache' })
 *
 * // Secure store for tokens
 * const tokens = createKVStore({ secure: true })
 * await tokens.set('accessToken', 'jwt...')
 * ```
 */
export function createKVStore(config: KVStoreConfig = {}): KVStore {
  const { secure = false, instanceId = 'mongrov-kv' } = config

  if (secure) {
    return new SecureBackend()
  }

  return new MMKVBackend(instanceId)
}
