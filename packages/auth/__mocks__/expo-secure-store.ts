const store = new Map<string, string>()

export const AFTER_FIRST_UNLOCK = 1
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 2
export const WHEN_UNLOCKED = 3

/** Every call's options, so tests can assert the keychain attributes used. */
export const __calls: Array<{ fn: string, key: string, options?: unknown }> = []

// The real module throws for keys outside this pattern, from getItem too.
const VALID_KEY = /^[\w.-]+$/
function ensureValidKey(key: string): void {
  if (!VALID_KEY.test(key))
    throw new Error('Invalid key provided to SecureStore.')
}

export const __fail = { read: false, write: false, deleteAsync: false }

export function getItem(key: string, options?: unknown): string | null {
  __calls.push({ fn: 'getItem', key, options })
  ensureValidKey(key)
  if (__fail.read)
    throw new Error('keychain unavailable')
  return store.get(key) ?? null
}

export function setItem(key: string, value: string, options?: unknown): void {
  __calls.push({ fn: 'setItem', key, options })
  ensureValidKey(key)
  if (__fail.write)
    throw new Error('keystore write refused')
  store.set(key, value)
}

export async function getItemAsync(key: string): Promise<string | null> {
  return store.get(key) ?? null
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  store.set(key, value)
}

export async function deleteItemAsync(key: string, options?: unknown): Promise<void> {
  __calls.push({ fn: 'deleteItemAsync', key, options })
  if (__fail.deleteAsync)
    throw new Error('delete refused')
  store.delete(key)
}

export function __resetSecureStore(): void {
  store.clear()
  __calls.length = 0
  __fail.read = false
  __fail.write = false
  __fail.deleteAsync = false
}
