import type { AuthLogger } from './types'
import { describeError, noopLogger } from './log'

/**
 * Synchronous credential storage on the keychain / Android keystore
 * (expo-secure-store), with an optional one-way migration off a plaintext
 * key-value store.
 *
 * Why synchronous: `SecureStore.getItem` / `setItem` are sync (expo-secure-store
 * 14+), so a store that hydrates at module load (e.g. a zustand store holding a
 * chat token) needs no async step and no loading state on cold start.
 *
 * Why one module for every credential: running two backends (one for the auth
 * client's tokens, another for a second service's token) lets them disagree
 * after a reinstall, so hydration succeeds on one side and fails on the other.
 * Put every credential the app keeps through one `SecureCredentials` instance.
 */

/**
 * expo-secure-store accepts only keys matching this, and THROWS otherwise —
 * from `getItem` just as much as from `setItem`. A key with a colon would crash
 * a module-load read, so every key is checked when the store is created.
 */
export const SECURE_STORE_KEY_PATTERN = /^[\w.-]+$/

/** The subset of a plaintext key-value store (e.g. an MMKV wrapper) migrated off. */
export interface LegacyCredentialStore {
  getString: (key: string) => string | null | undefined
  delete: (key: string) => void
}

export interface SecureCredentialsOptions<K extends string> {
  /**
   * Every credential key the app stores. Infers the app's `CredentialKey`
   * union (pass the array `as const`), and each key is checked against
   * `SECURE_STORE_KEY_PATTERN` here, so an illegal key fails at startup in
   * every environment instead of on device.
   *
   * These are the on-device keychain entry names: renaming one signs every
   * existing user out of it.
   */
  keys: readonly K[]
  /**
   * Plaintext store the credentials used to live in. On the first read that
   * finds nothing in the secure store, the legacy value is copied across and
   * the plaintext entry deleted; `delete` removes the plaintext entry too.
   * `keys` maps each credential key to its legacy spelling; unmapped keys are
   * not migrated.
   */
  legacy?: {
    store: LegacyCredentialStore
    keys: Partial<Record<K, string>>
  }
  /**
   * expo-secure-store `keychainAccessible` value. Default:
   * `AFTER_FIRST_UNLOCK` — readable by background work while the phone is
   * locked, and (unlike `*_THIS_DEVICE_ONLY`) kept on a restored backup.
   * Changing it for an existing app changes how entries are written; keep it
   * stable across releases.
   */
  keychainAccessible?: number
  /** Key names and failure reasons only, never values. Default: no-op. */
  logger?: AuthLogger
}

export interface SecureCredentials<K extends string> {
  readonly keys: readonly K[]
  /**
   * The stored value, or null. Never throws: an unreadable keychain (before
   * first unlock, invalidated entry) means "no usable credential", which an
   * auth gate already handles by sending the user to sign in. An empty string
   * reads as absent (see `delete`).
   */
  read: (key: K) => string | null
  /** Throws on failure: a write lost silently works all session and is gone on relaunch. */
  write: (key: K, value: string) => void
  /**
   * Leaves nothing readable by the time it returns: overwrites with `''`
   * synchronously, then removes the entry asynchronously, and deletes the
   * legacy plaintext entry. Never throws.
   */
  delete: (key: K) => void
}

/** The key union of a `SecureCredentials` instance. */
export type CredentialKeyOf<T> = T extends SecureCredentials<infer K> ? K : never

interface SecureStoreSync {
  AFTER_FIRST_UNLOCK: number
  getItem: (key: string, options?: { keychainAccessible?: number }) => string | null
  setItem: (key: string, value: string, options?: { keychainAccessible?: number }) => void
  deleteItemAsync: (key: string, options?: { keychainAccessible?: number }) => Promise<void>
}

const NO_SECURE_STORE = '[secure-credentials] expo-secure-store is unavailable'

let secureStore: SecureStoreSync | null | undefined

function loadSecureStore(): SecureStoreSync | null {
  if (secureStore !== undefined)
    return secureStore
  try {
    secureStore = require('expo-secure-store') as SecureStoreSync
  }
  catch {
    // expected when the optional peer is missing; reads return null, writes throw
    secureStore = null
  }
  return secureStore
}

export function createSecureCredentials<const K extends string>(
  options: SecureCredentialsOptions<K>,
): SecureCredentials<K> {
  const log = options.logger ?? noopLogger
  const legacy = options.legacy

  for (const key of options.keys) {
    if (!SECURE_STORE_KEY_PATTERN.test(key))
      throw new Error(`[secure-credentials] "${key}" is not a legal secure-store key (${String(SECURE_STORE_KEY_PATTERN)})`)
  }

  let reportedMissing = false
  function store(): SecureStoreSync | null {
    const found = loadSecureStore()
    if (!found && !reportedMissing) {
      reportedMissing = true
      log.error(NO_SECURE_STORE)
    }
    return found
  }

  // Built on first use: the accessibility constant comes from the module.
  let storeOptions: { keychainAccessible: number } | null = null
  function optionsFor(s: SecureStoreSync): { keychainAccessible: number } {
    storeOptions ??= { keychainAccessible: options.keychainAccessible ?? s.AFTER_FIRST_UNLOCK }
    return storeOptions
  }

  function write(key: K, value: string): void {
    const s = store()
    if (!s)
      throw new Error(NO_SECURE_STORE)
    s.setItem(key, value, optionsFor(s))
  }

  /**
   * One-way move off the plaintext store. The plaintext entry is DELETED once
   * the secure copy exists; if the secure write fails it is left alone and the
   * value still returned, so the session keeps working and the next read
   * retries.
   */
  function migrate(key: K): string | null {
    const legacyKey = legacy?.keys[key]
    if (!legacy || legacyKey == null)
      return null
    const value = legacy.store.getString(legacyKey)
    if (value == null || value === '')
      return null

    try {
      write(key, value)
    }
    catch (error) {
      log.warn('[secure-credentials] migration failed; value stays in legacy store', { key, error: describeError(error) })
      return value
    }

    legacy.store.delete(legacyKey)
    log.info('[secure-credentials] migrated off legacy store', { key })
    return value
  }

  return {
    keys: options.keys,

    read(key) {
      const s = store()
      if (!s)
        return null
      try {
        const found = s.getItem(key, optionsFor(s))
        if (found != null && found !== '')
          return found
      }
      catch (error) {
        log.error('[secure-credentials] read failed', { key, error: describeError(error) })
        return null
      }
      return migrate(key)
    },

    write,

    delete(key) {
      const s = store()
      if (s) {
        const opts = optionsFor(s)
        try {
          s.setItem(key, '', opts)
        }
        catch (error) {
          // The async delete below may still land; until then the value is readable.
          log.error('[secure-credentials] sync erase failed', { key, error: describeError(error) })
        }
        void s.deleteItemAsync(key, opts).catch((error: unknown) => {
          // Already overwritten with '' above, which reads as absent.
          log.warn('[secure-credentials] delete failed', { key, error: describeError(error) })
        })
      }
      // A user who signs out before anything read the credential never
      // triggered the migration; the plaintext copy must not outlive the logout.
      const legacyKey = legacy?.keys[key]
      if (legacy && legacyKey != null)
        legacy.store.delete(legacyKey)
    },
  }
}

/** @internal Reset the cached module (for testing) */
export function __resetSecureCredentialsModule(): void {
  secureStore = undefined
}
