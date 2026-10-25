import type { ColorScheme } from './types'
import { createStore } from 'zustand/vanilla'

const DEFAULT_STORAGE_KEY = '@mongrov/color-scheme'

interface ColorSchemeState {
  colorScheme: ColorScheme
  setColorScheme: (scheme: ColorScheme) => void
}

interface StorageBackend {
  getString: (key: string) => string | undefined
  set: (key: string, value: string) => void
}

/**
 * The default MMKV instance, on either react-native-mmkv major: v4's
 * `createMMKV` factory, or v3's `MMKV` class. v4 has no class, so reading
 * only that one meant the choice never persisted on v4 (mongrov-packages#34).
 * MMKV is an optional peer: without it the scheme still works, unpersisted.
 */
function getMMKVStorage(): StorageBackend | null {
  try {
    const mod = require('react-native-mmkv') as {
      createMMKV?: () => StorageBackend
      MMKV?: new () => StorageBackend
    }
    if (typeof mod.createMMKV === 'function')
      return mod.createMMKV()
    if (typeof mod.MMKV === 'function')
      return new mod.MMKV()
    return null
  }
  catch {
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

  const store = createStore<ColorSchemeState>(set => ({
    colorScheme: initial,
    setColorScheme: (scheme: ColorScheme) => {
      storage?.set(storageKey, scheme)
      set({ colorScheme: scheme })
    },
  }))

  return store
}
