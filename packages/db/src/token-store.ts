/**
 * Token store adapter
 *
 * Bridges KVStore to auth's TokenStore interface.
 * Allows @mongrov/auth to use KVStore for token persistence.
 */

import type { KVStore } from './types'

const ACCESS_KEY = 'mongrov.auth-access'
const REFRESH_KEY = 'mongrov.auth-refresh'

/**
 * TokenStore interface (matches @mongrov/auth TokenStore)
 * Re-defined here to avoid circular dependency.
 */
export interface TokenStore {
  getAccessToken(): Promise<string | null>
  setAccessToken(token: string): Promise<void>
  getRefreshToken(): Promise<string | null>
  setRefreshToken(token: string): Promise<void>
  clear(): Promise<void>
}

/**
 * Create a TokenStore backed by a KVStore.
 *
 * @example
 * ```typescript
 * import { createKVStore, createTokenStore } from '@mongrov/db'
 * import { createAuthClient } from '@mongrov/auth'
 *
 * // Use secure KVStore for tokens
 * const secureStore = createKVStore({ secure: true })
 * const tokenStore = createTokenStore(secureStore)
 *
 * const authClient = createAuthClient({
 *   adapter: myAdapter,
 *   tokenStore, // Inject the KVStore-backed token store
 * })
 * ```
 */
export function createTokenStore(kvStore: KVStore): TokenStore {
  return {
    async getAccessToken(): Promise<string | null> {
      return kvStore.get(ACCESS_KEY)
    },

    async setAccessToken(token: string): Promise<void> {
      await kvStore.set(ACCESS_KEY, token)
    },

    async getRefreshToken(): Promise<string | null> {
      return kvStore.get(REFRESH_KEY)
    },

    async setRefreshToken(token: string): Promise<void> {
      await kvStore.set(REFRESH_KEY, token)
    },

    async clear(): Promise<void> {
      await kvStore.delete(ACCESS_KEY)
      await kvStore.delete(REFRESH_KEY)
    },
  }
}
