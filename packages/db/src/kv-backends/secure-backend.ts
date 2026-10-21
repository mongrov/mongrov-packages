/**
 * SecureStore backend for KVStore.
 * Uses expo-secure-store for secure token/secret storage.
 */

import type { DBLogger, KVStore } from '../types'
import { noopLogger } from '../logger'

// Type for expo-secure-store module
type SecureStoreModule = typeof import('expo-secure-store')

// Lazy import to allow optional peer dependency
let cachedSecureStore: SecureStoreModule | null = null

function getSecureStore(): SecureStoreModule {
  if (cachedSecureStore) {
    return cachedSecureStore
  }

  try {
    cachedSecureStore = require('expo-secure-store') as SecureStoreModule
    return cachedSecureStore
  }
  catch {
    throw new Error(
      '@mongrov/db: expo-secure-store is required for secure KVStore. '
      + 'Install it with: npx expo install expo-secure-store',
    )
  }
}

// Key prefix for getAllKeys tracking (SecureStore doesn't have getAllKeys)
const KEYS_REGISTRY = '__mongrov_secure_keys__'

/**
 * SecureStore-backed KVStore implementation.
 * For tokens, secrets, and sensitive data.
 *
 * Note: SecureStore has platform limitations:
 * - iOS: Keychain (2048 byte limit per value)
 * - Android: SharedPreferences with encryption
 */
export class SecureBackend implements KVStore {
  private store: SecureStoreModule
  private readonly logger: DBLogger

  constructor(logger: DBLogger = noopLogger) {
    this.store = getSecureStore()
    this.logger = logger
  }

  async get(key: string): Promise<string | null> {
    return this.store.getItemAsync(key)
  }

  async set(key: string, value: string): Promise<void> {
    await this.store.setItemAsync(key, value)
    await this.trackKey(key)
  }

  async delete(key: string): Promise<void> {
    await this.store.deleteItemAsync(key)
    await this.untrackKey(key)
  }

  async getObject<T>(key: string): Promise<T | null> {
    const value = await this.store.getItemAsync(key)
    if (value === null)
      return null
    try {
      return JSON.parse(value) as T
    }
    catch (error) {
      // Key name only — the value may be a secret.
      this.logger.warn('[@mongrov/db] secure value is not JSON; treating as missing', {
        key,
        // Name only: JSON.parse messages quote the stored value.
        error: error instanceof Error ? error.name : 'unknown',
      })
      return null
    }
  }

  async setObject<T>(key: string, value: T): Promise<void> {
    await this.store.setItemAsync(key, JSON.stringify(value))
    await this.trackKey(key)
  }

  async clear(): Promise<void> {
    const keys = await this.getAllKeys()
    await Promise.all(keys.map(key => this.store.deleteItemAsync(key)))
    await this.store.deleteItemAsync(KEYS_REGISTRY)
  }

  async getAllKeys(): Promise<string[]> {
    const keysJson = await this.store.getItemAsync(KEYS_REGISTRY)
    if (!keysJson)
      return []
    try {
      return JSON.parse(keysJson) as string[]
    }
    catch (error) {
      // The registry is rewritten on the next set; until then clear() and
      // getAllKeys() cannot see the keys it tracked.
      this.logger.warn('[@mongrov/db] secure key registry is corrupt; treating as empty', {
        error: error instanceof Error ? error.name : 'unknown',
      })
      return []
    }
  }

  // ─── Internal key tracking ───────────────────────────────────────────────

  private async trackKey(key: string): Promise<void> {
    if (key === KEYS_REGISTRY)
      return
    const keys = await this.getAllKeys()
    if (!keys.includes(key)) {
      keys.push(key)
      await this.store.setItemAsync(KEYS_REGISTRY, JSON.stringify(keys))
    }
  }

  private async untrackKey(key: string): Promise<void> {
    if (key === KEYS_REGISTRY)
      return
    const keys = await this.getAllKeys()
    const filtered = keys.filter(k => k !== key)
    if (filtered.length !== keys.length) {
      await this.store.setItemAsync(KEYS_REGISTRY, JSON.stringify(filtered))
    }
  }
}
