/**
 * In-memory KVStore fake for migrations.test.ts and future tests.
 *
 * Backing map is exposed so tests can assert on stored values directly.
 * Not a test file (no `.test.ts`); vitest include glob skips it.
 */

import type { KVStore } from '../../types'

export interface FakeKV {
  kv: KVStore
  store: Map<string, unknown>
}

export function createFakeKV(): FakeKV {
  const store = new Map<string, unknown>()
  const kv: KVStore = {
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined
    },
    async set<T>(key: string, value: T): Promise<void> {
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  }
  return { kv, store }
}
