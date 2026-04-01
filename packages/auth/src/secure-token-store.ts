const ACCESS_KEY = '@mongrov/auth-access';
const REFRESH_KEY = '@mongrov/auth-refresh';

type SecureStoreModule = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

let secureStore: SecureStoreModule | null = null;
let mmkvFallback: { getString(k: string): string | undefined; set(k: string, v: string): void; delete(k: string): void } | null = null;

function getSecureStore(): SecureStoreModule | null {
  if (secureStore) return secureStore;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    secureStore = require('expo-secure-store') as SecureStoreModule;
    return secureStore;
  } catch {
    return null;
  }
}

function getMMKVFallback(): typeof mmkvFallback {
  if (mmkvFallback) return mmkvFallback;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MMKV } = require('react-native-mmkv') as { MMKV: new () => typeof mmkvFallback & object };
    mmkvFallback = new MMKV();
    return mmkvFallback;
  } catch {
    return null;
  }
}

async function getItem(key: string): Promise<string | null> {
  const store = getSecureStore();
  if (store) {
    return store.getItemAsync(key);
  }
  const fallback = getMMKVFallback();
  if (fallback) {
    return fallback.getString(key) ?? null;
  }
  return null;
}

let warnedNoBackend = false;

async function setItem(key: string, value: string): Promise<void> {
  const store = getSecureStore();
  if (store) {
    return store.setItemAsync(key, value);
  }
  const fallback = getMMKVFallback();
  if (fallback) {
    fallback.set(key, value);
    return;
  }
  if (!warnedNoBackend) {
    warnedNoBackend = true;
    console.warn(
      '[@mongrov/auth] No storage backend available (expo-secure-store or react-native-mmkv). Tokens will not persist.',
    );
  }
}

async function deleteItem(key: string): Promise<void> {
  const store = getSecureStore();
  if (store) {
    return store.deleteItemAsync(key);
  }
  const fallback = getMMKVFallback();
  if (fallback) {
    fallback.delete(key);
  }
}

export const SecureTokenStore = {
  getAccessToken(): Promise<string | null> {
    return getItem(ACCESS_KEY);
  },
  setAccessToken(token: string): Promise<void> {
    return setItem(ACCESS_KEY, token);
  },
  getRefreshToken(): Promise<string | null> {
    return getItem(REFRESH_KEY);
  },
  setRefreshToken(token: string): Promise<void> {
    return setItem(REFRESH_KEY, token);
  },
  async clear(): Promise<void> {
    await deleteItem(ACCESS_KEY);
    await deleteItem(REFRESH_KEY);
  },
};

/** @internal Reset module-level singletons (for testing) */
export function __resetStoreModules(): void {
  secureStore = null;
  mmkvFallback = null;
  warnedNoBackend = false;
}
