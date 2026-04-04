/**
 * Tests for createTokenStore (KVStore → TokenStore adapter)
 */

import { createKVStore } from '../kv-store'
import { createTokenStore } from '../token-store'
import type { TokenStore } from '../token-store'
import { __resetAllInstances } from '../../__mocks__/react-native-mmkv'
import { __resetSecureStore } from '../../__mocks__/expo-secure-store'

describe('createTokenStore', () => {
  beforeEach(() => {
    __resetAllInstances()
    __resetSecureStore()
  })

  describe('with MMKV backend', () => {
    let tokenStore: TokenStore

    beforeEach(() => {
      const kvStore = createKVStore({ instanceId: 'auth-tokens' })
      tokenStore = createTokenStore(kvStore)
    })

    it('should store and retrieve access token', async () => {
      await tokenStore.setAccessToken('access-jwt-123')
      expect(await tokenStore.getAccessToken()).toBe('access-jwt-123')
    })

    it('should store and retrieve refresh token', async () => {
      await tokenStore.setRefreshToken('refresh-jwt-456')
      expect(await tokenStore.getRefreshToken()).toBe('refresh-jwt-456')
    })

    it('should return null for missing access token', async () => {
      expect(await tokenStore.getAccessToken()).toBeNull()
    })

    it('should return null for missing refresh token', async () => {
      expect(await tokenStore.getRefreshToken()).toBeNull()
    })

    it('should clear both tokens', async () => {
      await tokenStore.setAccessToken('access')
      await tokenStore.setRefreshToken('refresh')

      await tokenStore.clear()

      expect(await tokenStore.getAccessToken()).toBeNull()
      expect(await tokenStore.getRefreshToken()).toBeNull()
    })

    it('should overwrite existing tokens', async () => {
      await tokenStore.setAccessToken('old-access')
      await tokenStore.setAccessToken('new-access')
      expect(await tokenStore.getAccessToken()).toBe('new-access')
    })
  })

  describe('with SecureStore backend', () => {
    let tokenStore: TokenStore

    beforeEach(() => {
      const kvStore = createKVStore({ secure: true })
      tokenStore = createTokenStore(kvStore)
    })

    it('should store and retrieve tokens securely', async () => {
      await tokenStore.setAccessToken('secure-access')
      await tokenStore.setRefreshToken('secure-refresh')

      expect(await tokenStore.getAccessToken()).toBe('secure-access')
      expect(await tokenStore.getRefreshToken()).toBe('secure-refresh')
    })

    it('should clear tokens from secure store', async () => {
      await tokenStore.setAccessToken('access')
      await tokenStore.setRefreshToken('refresh')

      await tokenStore.clear()

      expect(await tokenStore.getAccessToken()).toBeNull()
      expect(await tokenStore.getRefreshToken()).toBeNull()
    })
  })

  describe('isolation', () => {
    it('should isolate tokens between different KVStore instances', async () => {
      const kvStore1 = createKVStore({ instanceId: 'app-1' })
      const kvStore2 = createKVStore({ instanceId: 'app-2' })

      const tokenStore1 = createTokenStore(kvStore1)
      const tokenStore2 = createTokenStore(kvStore2)

      await tokenStore1.setAccessToken('token-for-app-1')
      await tokenStore2.setAccessToken('token-for-app-2')

      expect(await tokenStore1.getAccessToken()).toBe('token-for-app-1')
      expect(await tokenStore2.getAccessToken()).toBe('token-for-app-2')
    })
  })
})
