/**
 * MMKV backend for KVStore.
 * Wraps synchronous MMKV calls in async interface for API consistency.
 */

import type { KVStore } from '../types'

// Lazy import to allow optional peer dependency
let MMKV: typeof import('react-native-mmkv').MMKV

function getMMKV() {
  if (!MMKV) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      MMKV = require('react-native-mmkv').MMKV
    } catch {
      throw new Error(
        '@mongrov/db: react-native-mmkv is required for KVStore. ' +
          'Install it with: pnpm add react-native-mmkv'
      )
    }
  }
  return MMKV
}

/**
 * MMKV-backed KVStore implementation.
 * Fast synchronous storage wrapped in async API.
 */
export class MMKVBackend implements KVStore {
  private mmkv: InstanceType<typeof import('react-native-mmkv').MMKV>

  constructor(instanceId: string = 'mongrov-kv') {
    const MMKVClass = getMMKV()
    this.mmkv = new MMKVClass({ id: instanceId })
  }

  async get(key: string): Promise<string | null> {
    return this.mmkv.getString(key) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    this.mmkv.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.mmkv.delete(key)
  }

  async getObject<T>(key: string): Promise<T | null> {
    const value = this.mmkv.getString(key)
    if (value === undefined) return null
    try {
      return JSON.parse(value) as T
    } catch {
      return null
    }
  }

  async setObject<T>(key: string, value: T): Promise<void> {
    this.mmkv.set(key, JSON.stringify(value))
  }

  async clear(): Promise<void> {
    this.mmkv.clearAll()
  }

  async getAllKeys(): Promise<string[]> {
    return this.mmkv.getAllKeys()
  }
}
