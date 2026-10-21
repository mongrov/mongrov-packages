import type { AuthLogger, TokenStore } from './types'
import { noopLogger } from './log'

const ACCESS_KEY = 'mongrov.auth-access'
const REFRESH_KEY = 'mongrov.auth-refresh'

type SecureStoreModule = {
  getItemAsync: (key: string) => Promise<string | null>
  setItemAsync: (key: string, value: string) => Promise<void>
  deleteItemAsync: (key: string) => Promise<void>
}

let secureStore: SecureStoreModule | null = null
let mmkvFallback: { getString: (k: string) => string | undefined, set: (k: string, v: string) => void, delete: (k: string) => void } | null = null

function getSecureStore(): SecureStoreModule | null {
  if (secureStore)
    return secureStore
  try {
    secureStore = require('expo-secure-store') as SecureStoreModule
    return secureStore
  }
  catch {
    // expected: optional peer; the MMKV fallback is taken and warned about by the caller
    return null
  }
}

function getMMKVFallback(): typeof mmkvFallback {
  if (mmkvFallback)
    return mmkvFallback
  try {
    const { MMKV } = require('react-native-mmkv') as { MMKV: new () => typeof mmkvFallback & object }
    mmkvFallback = new MMKV()
    return mmkvFallback
  }
  catch {
    // expected: optional peer; setItem reports "no backend" once at error
    return null
  }
}

let warnedFallback = false

/**
 * Once per process: tokens are about to live in plain MMKV instead of the
 * keychain/keystore. Handled, but a security-relevant degradation.
 */
function warnFallbackOnce(log: AuthLogger): void {
  if (warnedFallback)
    return
  warnedFallback = true
  log.warn('[auth] expo-secure-store unavailable; tokens stored in MMKV (unencrypted)')
}

async function getItem(key: string, log: AuthLogger): Promise<string | null> {
  const store = getSecureStore()
  if (store) {
    return store.getItemAsync(key)
  }
  const fallback = getMMKVFallback()
  if (fallback) {
    warnFallbackOnce(log)
    return fallback.getString(key) ?? null
  }
  return null
}

let warnedNoBackend = false

async function setItem(key: string, value: string, log: AuthLogger): Promise<void> {
  const store = getSecureStore()
  if (store) {
    return store.setItemAsync(key, value)
  }
  const fallback = getMMKVFallback()
  if (fallback) {
    warnFallbackOnce(log)
    fallback.set(key, value)
    return
  }
  if (!warnedNoBackend) {
    warnedNoBackend = true
    // A token that is not written is a session lost on the next launch.
    log.error('[auth] no token storage backend (expo-secure-store or react-native-mmkv); tokens will not persist')
  }
}

async function deleteItem(key: string): Promise<void> {
  const store = getSecureStore()
  if (store) {
    return store.deleteItemAsync(key)
  }
  const fallback = getMMKVFallback()
  if (fallback) {
    fallback.delete(key)
  }
}

/**
 * Token store backed by expo-secure-store, falling back to MMKV, then to
 * nothing. `logger` receives those fallbacks; storage errors themselves
 * reject to the caller (the auth client), which logs them.
 */
export function createSecureTokenStore(options: { logger?: AuthLogger } = {}): TokenStore {
  const log = options.logger ?? noopLogger
  return {
    getAccessToken(): Promise<string | null> {
      return getItem(ACCESS_KEY, log)
    },
    setAccessToken(token: string): Promise<void> {
      return setItem(ACCESS_KEY, token, log)
    },
    getRefreshToken(): Promise<string | null> {
      return getItem(REFRESH_KEY, log)
    },
    setRefreshToken(token: string): Promise<void> {
      return setItem(REFRESH_KEY, token, log)
    },
    async clear(): Promise<void> {
      await deleteItem(ACCESS_KEY)
      await deleteItem(REFRESH_KEY)
    },
  }
}

/** Default store without a logger. Prefer `createSecureTokenStore({ logger })`. */
export const SecureTokenStore: TokenStore = createSecureTokenStore()

/** @internal Reset module-level singletons (for testing) */
export function __resetStoreModules(): void {
  secureStore = null
  mmkvFallback = null
  warnedNoBackend = false
  warnedFallback = false
}
