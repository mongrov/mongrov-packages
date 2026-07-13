import type { KVStore } from '../../core/types'

/** In-memory KVStore for rules tests. */
export function createFakeStorage(): KVStore & {
  __dump: () => Record<string, unknown>
  __clear: () => void
} {
  const store = new Map<string, unknown>()
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined
    },
    async set<T>(key: string, value: T): Promise<void> {
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
    __dump() {
      return Object.fromEntries(store.entries())
    },
    __clear() {
      store.clear()
    },
  }
}
