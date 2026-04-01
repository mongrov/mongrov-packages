import { SecureTokenStore, __resetStoreModules } from '../secure-token-store';
import { __resetSecureStore } from '../../__mocks__/expo-secure-store';
import { __resetMMKV } from '../../__mocks__/react-native-mmkv';

beforeEach(() => {
  __resetStoreModules();
  __resetSecureStore();
  __resetMMKV();
});

describe('SecureTokenStore', () => {
  describe('with expo-secure-store available', () => {
    it('stores and retrieves access token', async () => {
      await SecureTokenStore.setAccessToken('access-123');
      const token = await SecureTokenStore.getAccessToken();
      expect(token).toBe('access-123');
    });

    it('stores and retrieves refresh token', async () => {
      await SecureTokenStore.setRefreshToken('refresh-456');
      const token = await SecureTokenStore.getRefreshToken();
      expect(token).toBe('refresh-456');
    });

    it('returns null for missing token', async () => {
      const token = await SecureTokenStore.getAccessToken();
      expect(token).toBeNull();
    });

    it('clears all tokens', async () => {
      await SecureTokenStore.setAccessToken('access-123');
      await SecureTokenStore.setRefreshToken('refresh-456');
      await SecureTokenStore.clear();
      expect(await SecureTokenStore.getAccessToken()).toBeNull();
      expect(await SecureTokenStore.getRefreshToken()).toBeNull();
    });
  });

  describe('MMKV fallback', () => {
    beforeEach(() => {
      // Force MMKV fallback by making expo-secure-store unavailable
      jest.resetModules();
      jest.doMock('expo-secure-store', () => {
        throw new Error('Module not found');
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('falls back to MMKV when expo-secure-store is unavailable', async () => {
      __resetStoreModules();
      await SecureTokenStore.setAccessToken('mmkv-token');
      const token = await SecureTokenStore.getAccessToken();
      expect(token).toBe('mmkv-token');
    });

    it('clear works with MMKV fallback', async () => {
      __resetStoreModules();
      await SecureTokenStore.setAccessToken('mmkv-token');
      await SecureTokenStore.setRefreshToken('mmkv-refresh');
      await SecureTokenStore.clear();
      expect(await SecureTokenStore.getAccessToken()).toBeNull();
      expect(await SecureTokenStore.getRefreshToken()).toBeNull();
    });
  });
});
