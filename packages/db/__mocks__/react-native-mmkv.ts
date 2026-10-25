/**
 * Mock for react-native-mmkv
 * In-memory implementation for testing
 */

// Separate storage per instance ID for isolation testing
const instances: Map<string, Map<string, string>> = new Map()

export class MMKV {
  private storage: Map<string, string>
  private instanceId: string

  constructor(config?: { id?: string }) {
    this.instanceId = config?.id ?? 'default'

    if (!instances.has(this.instanceId)) {
      instances.set(this.instanceId, new Map())
    }
    this.storage = instances.get(this.instanceId)!
  }

  getString(key: string): string | undefined {
    return this.storage.get(key)
  }

  set(key: string, value: string | number | boolean): void {
    this.storage.set(key, String(value))
  }

  getNumber(key: string): number | undefined {
    const value = this.storage.get(key)
    return value !== undefined ? Number(value) : undefined
  }

  getBoolean(key: string): boolean | undefined {
    const value = this.storage.get(key)
    return value !== undefined ? value === 'true' : undefined
  }

  delete(key: string): void {
    this.storage.delete(key)
  }

  contains(key: string): boolean {
    return this.storage.has(key)
  }

  getAllKeys(): string[] {
    return Array.from(this.storage.keys())
  }

  clearAll(): void {
    this.storage.clear()
  }
}

/**
 * react-native-mmkv v4's factory, the version the app installs: no `MMKV`
 * class in real v4, `remove` instead of `delete`. Exported alongside the v3
 * class so the backend's v4 path is the one the suite exercises; the v3 path
 * is tested by mocking the module with the class alone.
 */
export function createMMKV(config?: { id?: string }) {
  const v3 = new MMKV(config)
  return {
    getString: (key: string) => v3.getString(key),
    set: (key: string, value: string | number | boolean) => v3.set(key, value),
    remove: (key: string) => {
      const had = v3.contains(key)
      v3.delete(key)
      return had
    },
    contains: (key: string) => v3.contains(key),
    getAllKeys: () => v3.getAllKeys(),
    clearAll: () => v3.clearAll(),
  }
}

// Test helper to reset all instances
export function __resetAllInstances(): void {
  instances.clear()
}

// Test helper to get storage for a specific instance
export function __getInstanceStorage(id: string = 'default'): Map<string, string> | undefined {
  return instances.get(id)
}
