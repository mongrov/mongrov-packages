/**
 * MMKV backend for KVStore.
 * Wraps synchronous MMKV calls in async interface for API consistency.
 * Falls back to in-memory storage if MMKV native module isn't available.
 */

import type { DBLogger, KVStore } from '../types'
import { describeError, devConsoleLogger } from '../logger'

// In-memory fallback storage
interface StorageLike {
  getString: (key: string) => string | undefined
  set: (key: string, value: string) => void
  delete: (key: string) => void
  getAllKeys: () => string[]
  clearAll: () => void
}

function createMemoryStorage(): StorageLike {
  const store = new Map<string, string>()
  return {
    getString: (key: string) => store.get(key),
    set: (key: string, value: string) => { store.set(key, value) },
    delete: (key: string) => { store.delete(key) },
    getAllKeys: () => Array.from(store.keys()),
    clearAll: () => { store.clear() },
  }
}

/**
 * MMKV-backed KVStore implementation.
 * Fast synchronous storage wrapped in async API.
 * Falls back to in-memory storage if native module isn't available.
 */
export class MMKVBackend implements KVStore {
  private instanceId: string
  private _storage: StorageLike | null = null
  private _mmkvAvailable: boolean | null = null
  private readonly logger: DBLogger

  constructor(instanceId: string = 'mongrov-kv', logger: DBLogger = devConsoleLogger) {
    this.instanceId = instanceId
    this.logger = logger
    // Don't initialize here - defer to first access
  }

  private getStorage(): StorageLike {
    if (this._storage)
      return this._storage

    if (this._mmkvAvailable === null) {
      try {
        const { MMKV } = require('react-native-mmkv')
        this._storage = new MMKV({ id: this.instanceId })
        this._mmkvAvailable = true
      }
      catch (e) {
        // Native module not available - use in-memory fallback. This can
        // happen during JS bundle evaluation before native modules are ready.
        // Nothing written to this store survives a restart.
        this.logger.warn(
          `[@mongrov/db] MMKV not available for instance "${this.instanceId}", using in-memory fallback`,
          { instanceId: this.instanceId, error: describeError(e) },
        )
        this._storage = createMemoryStorage()
        this._mmkvAvailable = false
      }
    }

    return this._storage!
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
