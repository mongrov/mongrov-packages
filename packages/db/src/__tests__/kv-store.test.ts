/**
 * Tests for createKVStore factory
 */

import { createKVStore } from '../kv-store'
import type { KVStore } from '../types'
import { __resetAllInstances } from '../../__mocks__/react-native-mmkv'
import { __resetSecureStore } from '../../__mocks__/expo-secure-store'

describe('createKVStore', () => {
  beforeEach(() => {
    __resetAllInstances()
    __resetSecureStore()
  })

  // ─── Factory Routing ─────────────────────────────────────────────────────

  describe('factory routing', () => {
    it('should create MMKV backend by default', async () => {
      const store = createKVStore()
      await store.set('key', 'value')
      expect(await store.get('key')).toBe('value')
    })

    it('should create MMKV backend when secure=false', async () => {
      const store = createKVStore({ secure: false })
      await store.set('key', 'value')
      expect(await store.get('key')).toBe('value')
    })

    it('should create SecureStore backend when secure=true', async () => {
      const store = createKVStore({ secure: true })
      await store.set('key', 'secure-value')
      expect(await store.get('key')).toBe('secure-value')
    })
  })

  // ─── String CRUD ─────────────────────────────────────────────────────────

  describe('string operations', () => {
    let store: KVStore

    beforeEach(() => {
      store = createKVStore()
    })

    it('should set and get a string value', async () => {
      await store.set('name', 'Alice')
      expect(await store.get('name')).toBe('Alice')
    })

    it('should return null for non-existent key', async () => {
      expect(await store.get('nonexistent')).toBeNull()
    })

    it('should overwrite existing value', async () => {
      await store.set('key', 'first')
      await store.set('key', 'second')
      expect(await store.get('key')).toBe('second')
    })

    it('should delete a key', async () => {
      await store.set('key', 'value')
      await store.delete('key')
      expect(await store.get('key')).toBeNull()
    })

    it('should handle delete of non-existent key', async () => {
      // Should not throw
      await store.delete('nonexistent')
      expect(await store.get('nonexistent')).toBeNull()
    })
  })

  // ─── Object JSON Operations ──────────────────────────────────────────────

  describe('object operations', () => {
    let store: KVStore

    beforeEach(() => {
      store = createKVStore()
    })

    it('should set and get an object', async () => {
      const user = { id: 1, name: 'Bob', active: true }
      await store.setObject('user', user)
      expect(await store.getObject('user')).toEqual(user)
    })

    it('should return null for non-existent object key', async () => {
      expect(await store.getObject('nonexistent')).toBeNull()
    })

    it('should handle nested objects', async () => {
      const config = {
        theme: { mode: 'dark', fontSize: 14 },
        features: ['a', 'b', 'c'],
      }
      await store.setObject('config', config)
      expect(await store.getObject('config')).toEqual(config)
    })

    it('should handle arrays', async () => {
      const items = [1, 2, 3, 'four', { five: 5 }]
      await store.setObject('items', items)
      expect(await store.getObject('items')).toEqual(items)
    })

    it('should return null for corrupted JSON', async () => {
      // Directly set invalid JSON via the string method
      await store.set('invalid', 'not-json{')
      expect(await store.getObject('invalid')).toBeNull()
    })
  })

  // ─── Clear and GetAllKeys ────────────────────────────────────────────────

  describe('clear and getAllKeys', () => {
    let store: KVStore

    beforeEach(() => {
      store = createKVStore()
    })

    it('should clear all keys', async () => {
      await store.set('a', '1')
      await store.set('b', '2')
      await store.set('c', '3')

      await store.clear()

      expect(await store.get('a')).toBeNull()
      expect(await store.get('b')).toBeNull()
      expect(await store.get('c')).toBeNull()
    })

    it('should return all keys', async () => {
      await store.set('key1', 'value1')
      await store.set('key2', 'value2')
      await store.set('key3', 'value3')

      const keys = await store.getAllKeys()
      expect(keys).toHaveLength(3)
      expect(keys).toContain('key1')
      expect(keys).toContain('key2')
      expect(keys).toContain('key3')
    })

    it('should return empty array when no keys', async () => {
      const keys = await store.getAllKeys()
      expect(keys).toEqual([])
    })
  })

  // ─── Secure Store Specific ───────────────────────────────────────────────

  describe('secure store', () => {
    let store: KVStore

    beforeEach(() => {
      store = createKVStore({ secure: true })
    })

    it('should set and get string in secure store', async () => {
      await store.set('token', 'jwt-abc123')
      expect(await store.get('token')).toBe('jwt-abc123')
    })

    it('should set and get object in secure store', async () => {
      const tokens = { access: 'abc', refresh: 'xyz' }
      await store.setObject('tokens', tokens)
      expect(await store.getObject('tokens')).toEqual(tokens)
    })

    it('should delete from secure store', async () => {
      await store.set('secret', 'value')
      await store.delete('secret')
      expect(await store.get('secret')).toBeNull()
    })

    it('should clear all in secure store', async () => {
      await store.set('a', '1')
      await store.set('b', '2')
      await store.clear()
      expect(await store.get('a')).toBeNull()
      expect(await store.get('b')).toBeNull()
    })

    it('should track keys in secure store', async () => {
      await store.set('key1', 'val1')
      await store.set('key2', 'val2')
      const keys = await store.getAllKeys()
      expect(keys).toContain('key1')
      expect(keys).toContain('key2')
    })
  })
})
