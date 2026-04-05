/**
 * MMKV backend for KVStore.
 * Wraps synchronous MMKV calls in async interface for API consistency.
 * Falls back to in-memory storage if MMKV native module isn't available.
 */

import type { KVStore } from '../types'

// React Native global
declare const __DEV__: boolean | undefined

// In-memory fallback storage
interface StorageLike {
  getString(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
  getAllKeys(): string[]
  clearAll(): void
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

  constructor(instanceId: string = 'mongrov-kv') {
    this.instanceId = instanceId
    // Don't initialize here - defer to first access
  }

  private getStorage(): StorageLike {
    if (this._storage) return this._storage

    if (this._mmkvAvailable === null) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { MMKV } = require('react-native-mmkv')
        this._storage = new MMKV({ id: this.instanceId })
        this._mmkvAvailable = true
      } catch (e) {
        // Native module not available - use in-memory fallback
        // This can happen during JS bundle evaluation before native modules are ready
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
          console.warn(
            `[@mongrov/db] MMKV not available for instance "${this.instanceId}", using in-memory fallback:`,
            e
          )
        }
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
    if (value === undefined) return null
    try {
      return JSON.parse(value) as T
    } catch {
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
