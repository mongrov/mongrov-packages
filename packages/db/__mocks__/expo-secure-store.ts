/**
 * Mock for expo-secure-store
 * In-memory implementation for testing
 */

const storage: Map<string, string> = new Map()

export async function getItemAsync(key: string): Promise<string | null> {
  return storage.get(key) ?? null
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  storage.set(key, value)
}

export async function deleteItemAsync(key: string): Promise<void> {
  storage.delete(key)
}

// Test helper to reset storage
export function __resetSecureStore(): void {
  storage.clear()
}

// Test helper to get all storage (for debugging)
export function __getSecureStoreSnapshot(): Record<string, string> {
  return Object.fromEntries(storage.entries())
}
