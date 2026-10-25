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

function getSecureStore(): SecureStoreModule | null {
  if (secureStore)
    return secureStore
  try {
    secureStore = require('expo-secure-store') as SecureStoreModule
    return secureStore
  }
  catch {
    // expected when the peer is missing; setItem fails visibly, below
    return null
  }
}

/*
 * No plain-storage fallback. This store used to write tokens to plain MMKV
 * when expo-secure-store was missing, with a warning. Tokens never go in
 * plain MMKV, and on react-native-mmkv v4 that fallback could not even open
 * (mongrov-packages#34). Without the keychain/keystore, saving a token
 * REJECTS, so sign-in fails with the reason instead of leaving a credential
 * in the clear or a session that is gone on the next launch.
 */
const NO_SECURE_STORE = '[auth] expo-secure-store is unavailable; tokens cannot be stored'

// Per logger, not per process: a store without a logger (the default
// `SecureTokenStore`, whose logger is a no-op) would otherwise spend the one
// report, and the app's own logger never see it.
let reportedNoBackend = new WeakSet<AuthLogger>()

async function getItem(key: string): Promise<string | null> {
  const store = getSecureStore()
  // Nothing can have been stored without it: signed out, not an error.
  return store ? store.getItemAsync(key) : null
}

async function setItem(key: string, value: string, log: AuthLogger): Promise<void> {
  const store = getSecureStore()
  if (store)
    return store.setItemAsync(key, value)
  if (!reportedNoBackend.has(log)) {
    reportedNoBackend.add(log)
    log.error(NO_SECURE_STORE)
  }
  throw new Error(NO_SECURE_STORE)
}

async function deleteItem(key: string): Promise<void> {
  const store = getSecureStore()
  if (store)
    return store.deleteItemAsync(key)
}

/**
 * Token store backed by expo-secure-store, and nothing else. `logger` hears
 * once when it is missing; storage errors reject to the caller (the auth
 * client), which logs them.
 */
export function createSecureTokenStore(options: { logger?: AuthLogger } = {}): TokenStore {
  const log = options.logger ?? noopLogger
  return {
    getAccessToken(): Promise<string | null> {
      return getItem(ACCESS_KEY)
    },
    setAccessToken(token: string): Promise<void> {
      return setItem(ACCESS_KEY, token, log)
    },
    getRefreshToken(): Promise<string | null> {
      return getItem(REFRESH_KEY)
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
  reportedNoBackend = new WeakSet()
}
