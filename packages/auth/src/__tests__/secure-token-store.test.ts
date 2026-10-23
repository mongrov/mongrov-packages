import { __resetSecureStore } from '../../__mocks__/expo-secure-store'
import { __resetMMKV } from '../../__mocks__/react-native-mmkv'
import { __resetStoreModules, createSecureTokenStore, SecureTokenStore } from '../secure-token-store'

beforeEach(() => {
  __resetStoreModules()
  __resetSecureStore()
  __resetMMKV()
})

describe('SecureTokenStore', () => {
  describe('with expo-secure-store available', () => {
    it('stores and retrieves access token', async () => {
      await SecureTokenStore.setAccessToken('access-123')
      const token = await SecureTokenStore.getAccessToken()
      expect(token).toBe('access-123')
    })

    it('stores and retrieves refresh token', async () => {
      await SecureTokenStore.setRefreshToken('refresh-456')
      const token = await SecureTokenStore.getRefreshToken()
      expect(token).toBe('refresh-456')
    })

    it('returns null for missing token', async () => {
      const token = await SecureTokenStore.getAccessToken()
      expect(token).toBeNull()
    })

    it('clears all tokens', async () => {
      await SecureTokenStore.setAccessToken('access-123')
      await SecureTokenStore.setRefreshToken('refresh-456')
      await SecureTokenStore.clear()
      expect(await SecureTokenStore.getAccessToken()).toBeNull()
      expect(await SecureTokenStore.getRefreshToken()).toBeNull()
    })
  })

  describe('MMKV fallback', () => {
    beforeEach(() => {
      // Force MMKV fallback by making expo-secure-store unavailable
      jest.resetModules()
      jest.doMock('expo-secure-store', () => {
        throw new Error('Module not found')
      })
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('falls back to MMKV when expo-secure-store is unavailable', async () => {
      __resetStoreModules()
      await SecureTokenStore.setAccessToken('mmkv-token')
      const token = await SecureTokenStore.getAccessToken()
      expect(token).toBe('mmkv-token')
    })

    it('warns every logger about the MMKV fallback, not only the first store to hit it', async () => {
      __resetStoreModules()
      // The default store's no-op logger hits the fallback first.
      await SecureTokenStore.setAccessToken('mmkv-token')
      const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      const store = createSecureTokenStore({ logger })
      await store.getAccessToken()
      await store.getRefreshToken()
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.warn).toHaveBeenCalledWith('[auth] expo-secure-store unavailable; tokens stored in MMKV (unencrypted)')
    })

    it('clear works with MMKV fallback', async () => {
      __resetStoreModules()
      await SecureTokenStore.setAccessToken('mmkv-token')
      await SecureTokenStore.setRefreshToken('mmkv-refresh')
      await SecureTokenStore.clear()
      expect(await SecureTokenStore.getAccessToken()).toBeNull()
      expect(await SecureTokenStore.getRefreshToken()).toBeNull()
    })
  })
})
