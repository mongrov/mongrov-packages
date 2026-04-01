const store = new Map<string, string>();

export class MMKV {
  getString(key: string): string | undefined {
    return store.get(key);
  }

  set(key: string, value: string): void {
    store.set(key, value);
  }

  delete(key: string): void {
    store.delete(key);
  }

  clearAll(): void {
    store.clear();
  }
}

export function __resetMMKV(): void {
  store.clear();
}
