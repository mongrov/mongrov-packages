import type { CredentialKeyOf, SecureCredentials } from '../secure-credentials'
import * as SecureStore from 'expo-secure-store'
import {
  __resetSecureCredentialsModule,
  createSecureCredentials,
  SECURE_STORE_KEY_PATTERN,
} from '../secure-credentials'

const mockStore = SecureStore as unknown as {
  AFTER_FIRST_UNLOCK: number
  WHEN_UNLOCKED: number
  __calls: Array<{ fn: string, key: string, options?: unknown }>
  __fail: { read: boolean, write: boolean, deleteAsync: boolean }
  __resetSecureStore: () => void
}

// The keys an app declares, each paired with where it used to live in plaintext.
const KEYS = ['app.auth-access', 'app.auth-refresh', 'chat.authToken', 'chat.userId'] as const
type Key = typeof KEYS[number]
const LEGACY: Record<Key, string> = {
  'app.auth-access': 'app.auth-access',
  'app.auth-refresh': 'app.auth-refresh',
  'chat.authToken': 'chat:authToken',
  'chat.userId': 'chat:userId',
}

let plaintext: Map<string, string>
let legacyStore: { getString: jest.Mock, delete: jest.Mock }
let logger: Record<'debug' | 'info' | 'warn' | 'error', jest.Mock>
let creds: SecureCredentials<Key>

beforeEach(() => {
  mockStore.__resetSecureStore()
  __resetSecureCredentialsModule()
  plaintext = new Map()
  legacyStore = {
    getString: jest.fn((key: string) => plaintext.get(key)),
    delete: jest.fn((key: string) => { plaintext.delete(key) }),
  }
  logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  creds = createSecureCredentials({ keys: KEYS, legacy: { store: legacyStore, keys: LEGACY }, logger })
})

function loggedText(): string {
  return JSON.stringify(Object.values(logger).map(m => m.mock.calls))
}

describe('key type', () => {
  it('infers the app-supplied key union', () => {
    // Compile-time: a key outside the union is a tsc error.
    const key: CredentialKeyOf<typeof creds> = 'chat.authToken'
    // @ts-expect-error not one of the declared keys
    const bad: CredentialKeyOf<typeof creds> = 'chat:authToken'
    expect([key, bad]).toHaveLength(2)
    expect(creds.keys).toEqual(KEYS)
  })

  it('rejects an illegal secure-store key at creation, not on device', () => {
    expect(() => createSecureCredentials({ keys: ['chat:authToken'] })).toThrow(/not a legal secure-store key/)
  })

  it.each(KEYS)('%s is a legal key', (key) => {
    expect(key).toMatch(SECURE_STORE_KEY_PATTERN)
  })
})

describe('keychain options (existing entries stay readable)', () => {
  it('uses the key as given and AFTER_FIRST_UNLOCK, with no service namespace', () => {
    creds.write('chat.authToken', 'tok')
    creds.read('chat.authToken')
    creds.delete('chat.authToken')
    for (const call of mockStore.__calls) {
      expect(call.key).toBe('chat.authToken')
      expect(call.options).toEqual({ keychainAccessible: mockStore.AFTER_FIRST_UNLOCK })
    }
    expect(mockStore.__calls.map(c => c.fn)).toEqual(['setItem', 'getItem', 'setItem', 'deleteItemAsync'])
  })

  it('takes keychainAccessible from options', () => {
    const c = createSecureCredentials({ keys: KEYS, keychainAccessible: mockStore.WHEN_UNLOCKED })
    c.write('chat.userId', 'u')
    expect(mockStore.__calls[0].options).toEqual({ keychainAccessible: mockStore.WHEN_UNLOCKED })
  })
})

describe('read', () => {
  it('returns a value written through write', () => {
    creds.write('chat.authToken', 'rc-token')
    expect(creds.read('chat.authToken')).toBe('rc-token')
  })

  it('returns null when nothing is stored anywhere', () => {
    expect(creds.read('chat.authToken')).toBeNull()
  })

  it('treats an empty string as absent', () => {
    creds.write('chat.authToken', '')
    expect(creds.read('chat.authToken')).toBeNull()
  })

  it('does not reach the legacy store once the secure store has the value', () => {
    creds.write('app.auth-refresh', 'secure-copy')
    plaintext.set('app.auth-refresh', 'stale-plaintext-copy')
    expect(creds.read('app.auth-refresh')).toBe('secure-copy')
    expect(legacyStore.getString).not.toHaveBeenCalled()
  })

  it('survives a keychain that cannot be read, and does not migrate then', () => {
    mockStore.__fail.read = true
    plaintext.set('app.auth-refresh', 'plaintext')
    expect(creds.read('app.auth-refresh')).toBeNull()
    expect(legacyStore.delete).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('[secure-credentials] read failed', expect.objectContaining({ key: 'app.auth-refresh' }))
  })

  it('works without a legacy store', () => {
    const c = createSecureCredentials({ keys: KEYS })
    expect(c.read('chat.userId')).toBeNull()
    expect(() => c.delete('chat.userId')).not.toThrow()
  })
})

describe('migration off the plaintext store', () => {
  it.each(KEYS.map(k => [k, LEGACY[k]]))('moves %s across on first read and deletes the plaintext copy', (key, legacy) => {
    plaintext.set(legacy, 'migrated')
    expect(creds.read(key as Key)).toBe('migrated')
    expect(legacyStore.delete).toHaveBeenCalledWith(legacy)
    expect(plaintext.has(legacy)).toBe(false)
    legacyStore.getString.mockClear()
    // Runs once: the second read is served from the secure store.
    expect(creds.read(key as Key)).toBe('migrated')
    expect(legacyStore.getString).not.toHaveBeenCalled()
  })

  it('keeps the plaintext copy when the secure write fails, and still works', () => {
    plaintext.set('chat:authToken', 'plaintext')
    mockStore.__fail.write = true
    expect(creds.read('chat.authToken')).toBe('plaintext')
    expect(legacyStore.delete).not.toHaveBeenCalled()
  })

  it('skips keys with no legacy mapping', () => {
    const c = createSecureCredentials({ keys: KEYS, legacy: { store: legacyStore, keys: {} } })
    plaintext.set('chat:userId', 'x')
    expect(c.read('chat.userId')).toBeNull()
    expect(legacyStore.getString).not.toHaveBeenCalled()
  })
})

describe('write', () => {
  it('throws rather than losing a write silently', () => {
    mockStore.__fail.write = true
    expect(() => creds.write('chat.authToken', 'rc-token')).toThrow('keystore write refused')
  })
})

describe('delete', () => {
  it('leaves nothing readable by the time it returns', () => {
    creds.write('chat.authToken', 'rc-token')
    creds.delete('chat.authToken')
    expect(creds.read('chat.authToken')).toBeNull()
  })

  it.each(KEYS.map(k => [k, LEGACY[k]]))('clears the legacy plaintext entry for %s too', (key, legacy) => {
    creds.delete(key as Key)
    expect(legacyStore.delete).toHaveBeenCalledWith(legacy)
  })

  it('still clears when the synchronous erase is refused', () => {
    creds.write('chat.authToken', 'rc-token')
    mockStore.__fail.write = true
    expect(() => creds.delete('chat.authToken')).not.toThrow()
    expect(legacyStore.delete).toHaveBeenCalledWith('chat:authToken')
    expect(logger.error).toHaveBeenCalledWith('[secure-credentials] sync erase failed', expect.any(Object))
  })

  it('logs a failed async delete as a warning', async () => {
    mockStore.__fail.deleteAsync = true
    creds.delete('chat.userId')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(logger.warn).toHaveBeenCalledWith('[secure-credentials] delete failed', expect.objectContaining({ key: 'chat.userId' }))
  })
})

describe('logging', () => {
  it('logs key names only across migration and failures', () => {
    plaintext.set('chat:authToken', 'SECRETvalue123')
    creds.read('chat.authToken')
    mockStore.__fail.write = true
    plaintext.set('chat:userId', 'SECRETuser456')
    creds.read('chat.userId')
    expect(logger.info).toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
    expect(loggedText()).not.toContain('SECRETvalue123')
    expect(loggedText()).not.toContain('SECRETuser456')
  })
})

describe('without expo-secure-store', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.doMock('expo-secure-store', () => {
      throw new Error('Cannot find module')
    })
  })
  afterEach(() => {
    jest.dontMock('expo-secure-store')
  })

  it('reads null, refuses writes, and reports once', () => {
    const mod = require('../secure-credentials') as typeof import('../secure-credentials')
    const c = mod.createSecureCredentials({ keys: KEYS, logger, legacy: { store: legacyStore, keys: LEGACY } })
    expect(c.read('chat.userId')).toBeNull()
    expect(() => c.write('chat.userId', 'x')).toThrow(/unavailable/)
    c.delete('chat.userId')
    expect(legacyStore.delete).toHaveBeenCalledWith('chat:userId')
    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})
