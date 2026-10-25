/**
 * MMKV backend for KVStore.
 * Wraps synchronous MMKV calls in async interface for API consistency.
 */

import type { DBLogger, KVStore } from '../types'
import type { MMKVStorage } from './open-mmkv'
import { describeError, devConsoleLogger } from '../logger'
import { openMMKV } from './open-mmkv'

/**
 * MMKV-backed KVStore implementation.
 * Fast synchronous storage wrapped in async API.
 *
 * No in-memory fallback. One used to stand in whenever MMKV failed to open,
 * so a store that persists nothing reported every write as a success; on
 * react-native-mmkv v4 that was every store (mongrov-packages#34). A store
 * that cannot persist now throws on use, and logs why. The failure is not
 * cached: a call made before the native module is ready can succeed later.
 */
export class MMKVBackend implements KVStore {
  private instanceId: string
  private _storage: MMKVStorage | null = null
  private readonly logger: DBLogger

  constructor(instanceId: string = 'mongrov-kv', logger: DBLogger = devConsoleLogger) {
    this.instanceId = instanceId
    this.logger = logger
    // Don't initialize here - defer to first access
  }

  private getStorage(): MMKVStorage {
    if (this._storage)
      return this._storage
    try {
      this._storage = openMMKV(this.instanceId)
      return this._storage
    }
    catch (e) {
      this.logger.error(
        `[@mongrov/db] MMKV could not open instance "${this.instanceId}"; nothing can be stored`,
        { instanceId: this.instanceId, error: describeError(e) },
      )
      throw new Error(`@mongrov/db: MMKV instance "${this.instanceId}" could not be opened: ${describeError(e)}`)
    }
  }

  async get(key: string): Promise<string | null> {
    return this.getStorage().getString(key) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    this.getStorage().set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.getStorage().delete(key)
  }

  async getObject<T>(key: string): Promise<T | null> {
    const value = this.getStorage().getString(key)
    if (value === undefined)
      return null
    try {
      return JSON.parse(value) as T
    }
    catch (error) {
      this.logger.warn('[@mongrov/db] stored value is not JSON; treating as missing', {
        instanceId: this.instanceId,
        key,
        // Name only: JSON.parse messages quote the stored value.
        error: error instanceof Error ? error.name : 'unknown',
      })
      return null
    }
  }

  async setObject<T>(key: string, value: T): Promise<void> {
    this.getStorage().set(key, JSON.stringify(value))
  }

  async clear(): Promise<void> {
    this.getStorage().clearAll()
  }

  async getAllKeys(): Promise<string[]> {
    return this.getStorage().getAllKeys()
  }
}
