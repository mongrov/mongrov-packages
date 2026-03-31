const storage: Record<string, string> = {}

export class MMKV {
  getString(key: string): string | undefined {
    return storage[key]
  }
  set(key: string, value: string): void {
    storage[key] = value
  }
  delete(key: string): void {
    delete storage[key]
  }
  contains(key: string): boolean {
    return key in storage
  }
  clearAll(): void {
    Object.keys(storage).forEach((k) => delete storage[k])
  }
  // Expose for test manipulation
  static __storage = storage
}
