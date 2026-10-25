/**
 * Tests for KV backend implementations
 */

import { __resetSecureStore } from '../../__mocks__/expo-secure-store'
import {
  __getInstanceStorage,
  __resetAllInstances,
} from '../../__mocks__/react-native-mmkv'
import { MMKVBackend } from '../kv-backends/mmkv-backend'
import { SecureBackend } from '../kv-backends/secure-backend'

describe('MMKVBackend', () => {
  beforeEach(() => {
    __resetAllInstances()
  })

  describe('instance isolation', () => {
    it('should use default instance ID', async () => {
      const store = new MMKVBackend()
      await store.set('key', 'value')

      const defaultStorage = __getInstanceStorage('mongrov-kv')
      expect(defaultStorage?.get('key')).toBe('value')
    })

    it('should use custom instance ID', async () => {
      const store = new MMKVBackend('custom-id')
      await store.set('key', 'custom-value')

      const customStorage = __getInstanceStorage('custom-id')
      expect(customStorage?.get('key')).toBe('custom-value')

      // Default should not have the key
      const defaultStorage = __getInstanceStorage('mongrov-kv')
      expect(defaultStorage).toBeUndefined()
    })

    it('should isolate data between instances', async () => {
      const store1 = new MMKVBackend('instance-1')
      const store2 = new MMKVBackend('instance-2')

      await store1.set('key', 'value-1')
      await store2.set('key', 'value-2')

      expect(await store1.get('key')).toBe('value-1')
      expect(await store2.get('key')).toBe('value-2')
    })

    it('should share data within same instance ID', async () => {
      const store1 = new MMKVBackend('shared')
      const store2 = new MMKVBackend('shared')

      await store1.set('key', 'shared-value')
      expect(await store2.get('key')).toBe('shared-value')
    })
  })

  describe('getAllKeys', () => {
    it('should return all keys in the instance', async () => {
      const store = new MMKVBackend('test-keys')
      await store.set('a', '1')
      await store.set('b', '2')
      await store.set('c', '3')

      const keys = await store.getAllKeys()
      expect(keys.sort()).toEqual(['a', 'b', 'c'])
    })
  })
})

describe('SecureBackend', () => {
  beforeEach(() => {
    __resetSecureStore()
  })

  describe('key tracking', () => {
    it('should track keys for getAllKeys', async () => {
      const store = new SecureBackend()

      await store.set('token', 'abc')
      await store.set('secret', 'xyz')

      const keys = await store.getAllKeys()
      expect(keys).toContain('token')
      expect(keys).toContain('secret')
    })

    it('should untrack keys on delete', async () => {
      const store = new SecureBackend()

      await store.set('key1', 'val1')
      await store.set('key2', 'val2')
      await store.delete('key1')

      const keys = await store.getAllKeys()
      expect(keys).not.toContain('key1')
      expect(keys).toContain('key2')
    })

    it('should clear key tracking on clear()', async () => {
      const store = new SecureBackend()

      await store.set('a', '1')
      await store.set('b', '2')
      await store.clear()

      const keys = await store.getAllKeys()
      expect(keys).toEqual([])
    })
  })

  describe('JSON handling', () => {
    it('should handle getObject with null value', async () => {
      const store = new SecureBackend()
      expect(await store.getObject('nonexistent')).toBeNull()
    })

    it('should return null for invalid JSON in getObject', async () => {
      const store = new SecureBackend()
      await store.set('invalid', 'not{json')
      expect(await store.getObject('invalid')).toBeNull()
    })

    it('warns through the injected logger without logging the value', async () => {
      const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      const store = new SecureBackend(logger)
      await store.set('invalid', 'not{json-secret')
      expect(await store.getObject('invalid')).toBeNull()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('not JSON'),
        expect.objectContaining({ key: 'invalid' }),
      )
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret')
    })
  })
})

describe('MMKVBackend logging', () => {
  it('warns through the injected logger on unparseable values', async () => {
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const store = new MMKVBackend('log-test', logger)
    await store.set('bad', 'not{json')
    expect(await store.getObject('bad')).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not JSON'),
      expect.objectContaining({ instanceId: 'log-test', key: 'bad' }),
    )
  })

  it('fails visibly when MMKV cannot open, and logs why — no in-memory stand-in', async () => {
    jest.resetModules()
    jest.doMock('react-native-mmkv', () => {
      throw new Error('native module missing')
    })
    const { MMKVBackend: Isolated } = require('../kv-backends/mmkv-backend') as typeof import('../kv-backends/mmkv-backend')
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const store = new Isolated('broken', logger)
    await expect(store.set('k', 'v')).rejects.toThrow('could not be opened')
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not open'),
      expect.objectContaining({ instanceId: 'broken', error: expect.stringContaining('native module missing') }),
    )
    jest.dontMock('react-native-mmkv')
  })

  it('does not cache the failure: a store opened before MMKV is ready works once it is', async () => {
    jest.resetModules()
    let ready = false
    const real = jest.requireActual('../../__mocks__/react-native-mmkv') as typeof import('../../__mocks__/react-native-mmkv')
    jest.doMock('react-native-mmkv', () => ({
      createMMKV: (config?: { id?: string }) => {
        if (!ready)
          throw new Error('not ready')
        return real.createMMKV(config)
      },
    }))
    const { MMKVBackend: Isolated } = require('../kv-backends/mmkv-backend') as typeof import('../kv-backends/mmkv-backend')
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const store = new Isolated('late', logger)
    await expect(store.get('k')).rejects.toThrow('not ready')
    ready = true
    await store.set('k', 'v')
    expect(await store.get('k')).toBe('v')
    jest.dontMock('react-native-mmkv')
  })
})

describe('MMKVBackend on each react-native-mmkv major', () => {
  afterEach(() => jest.dontMock('react-native-mmkv'))

  /** The store, reopened on the same instance id: what a relaunch sees. */
  async function roundTrip(mod: object) {
    jest.resetModules()
    jest.doMock('react-native-mmkv', () => mod)
    const { MMKVBackend: Isolated } = require('../kv-backends/mmkv-backend') as typeof import('../kv-backends/mmkv-backend')
    const first = new Isolated('persisted')
    await first.set('a', '1')
    await first.set('b', '2')
    await first.delete('b')
    const reopened = new Isolated('persisted')
    return { a: await reopened.get('a'), b: await reopened.get('b'), keys: await reopened.getAllKeys() }
  }

  it('v4 (createMMKV, remove): writes survive a reopen, delete removes', async () => {
    const real = jest.requireActual('../../__mocks__/react-native-mmkv') as typeof import('../../__mocks__/react-native-mmkv')
    real.__resetAllInstances()
    // The real v4 export shape: the factory only, instances with no `delete`.
    expect(await roundTrip({ createMMKV: real.createMMKV })).toEqual({ a: '1', b: null, keys: ['a'] })
  })

  it('v3 (new MMKV, delete): writes survive a reopen, delete removes', async () => {
    const real = jest.requireActual('../../__mocks__/react-native-mmkv') as typeof import('../../__mocks__/react-native-mmkv')
    real.__resetAllInstances()
    expect(await roundTrip({ MMKV: real.MMKV })).toEqual({ a: '1', b: null, keys: ['a'] })
  })

  it('neither export: throws rather than persisting nowhere', async () => {
    await expect(roundTrip({})).rejects.toThrow('neither createMMKV (v4) nor MMKV (v3)')
  })
})
