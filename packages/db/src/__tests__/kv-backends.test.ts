/**
 * Tests for KV backend implementations
 */

import { MMKVBackend } from '../kv-backends/mmkv-backend'
import { SecureBackend } from '../kv-backends/secure-backend'
import {
  __resetAllInstances,
  __getInstanceStorage,
} from '../../__mocks__/react-native-mmkv'
import { __resetSecureStore } from '../../__mocks__/expo-secure-store'

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
  })
})
