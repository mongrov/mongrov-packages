import { createStore } from 'zustand/vanilla'
import type { ColorScheme } from './types'

const DEFAULT_STORAGE_KEY = '@mongrov/color-scheme'

interface ColorSchemeState {
  colorScheme: ColorScheme
  setColorScheme: (scheme: ColorScheme) => void
}

interface StorageBackend {
  getString(key: string): string | undefined
  set(key: string, value: string): void
}

function getMMKVStorage(): StorageBackend | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MMKV } = require('react-native-mmkv') as { MMKV: new () => StorageBackend }
    return new MMKV()
  } catch {
    return null
  }
}

export function createColorSchemeStore(options?: {
  defaultColorScheme?: ColorScheme
  storageKey?: string
}) {
  const storageKey = options?.storageKey ?? DEFAULT_STORAGE_KEY
  const defaultScheme = options?.defaultColorScheme ?? 'system'
  const storage = getMMKVStorage()

  // Load persisted value
  let initial = defaultScheme
  if (storage) {
    const persisted = storage.getString(storageKey)
    if (persisted === 'light' || persisted === 'dark' || persisted === 'system') {
      initial = persisted
    }
  }

  const store = createStore<ColorSchemeState>((set) => ({
    colorScheme: initial,
    setColorScheme: (scheme: ColorScheme) => {
      storage?.set(storageKey, scheme)
      set({ colorScheme: scheme })
    },
  }))

  return store
}
