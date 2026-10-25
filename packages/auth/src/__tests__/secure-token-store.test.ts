import { __resetSecureStore } from '../../__mocks__/expo-secure-store'
import { __resetStoreModules, createSecureTokenStore, SecureTokenStore } from '../secure-token-store'

beforeEach(() => {
  __resetStoreModules()
  __resetSecureStore()
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

  describe('without expo-secure-store: no plaintext fallback', () => {
    beforeEach(() => {
      jest.resetModules()
      jest.doMock('expo-secure-store', () => {
        throw new Error('Module not found')
      })
      __resetStoreModules()
    })

    afterEach(() => {
      jest.dontMock('expo-secure-store')
      jest.restoreAllMocks()
    })

    it('rejects a token write instead of storing it in plain MMKV', async () => {
      await expect(SecureTokenStore.setAccessToken('t')).rejects.toThrow('expo-secure-store is unavailable')
      expect(await SecureTokenStore.getAccessToken()).toBeNull()
    })

    it('tells every logger once, not only the first store to hit it', async () => {
      await expect(SecureTokenStore.setAccessToken('t')).rejects.toThrow()
      const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      const store = createSecureTokenStore({ logger })
      await expect(store.setAccessToken('t')).rejects.toThrow()
      await expect(store.setRefreshToken('r')).rejects.toThrow()
      expect(logger.error).toHaveBeenCalledTimes(1)
      expect(logger.error).toHaveBeenCalledWith('[auth] expo-secure-store is unavailable; tokens cannot be stored')
    })

    it('reads as signed out, and clear is a no-op', async () => {
      await SecureTokenStore.clear()
      expect(await SecureTokenStore.getRefreshToken()).toBeNull()
    })
  })
})
