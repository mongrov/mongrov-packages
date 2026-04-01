import { createColorSchemeStore } from '../color-scheme-store'

// Mock is loaded via moduleNameMapper in jest.config.js
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __resetMMKV } = require('react-native-mmkv') as { __resetMMKV: () => void }

beforeEach(() => {
  __resetMMKV()
})

describe('createColorSchemeStore', () => {
  it('should default to system', () => {
    const store = createColorSchemeStore()
    expect(store.getState().colorScheme).toBe('system')
  })

  it('should use custom default color scheme', () => {
    const store = createColorSchemeStore({ defaultColorScheme: 'dark' })
    expect(store.getState().colorScheme).toBe('dark')
  })

  it('should persist preference via setColorScheme', () => {
    const store = createColorSchemeStore()
    store.getState().setColorScheme('dark')
    expect(store.getState().colorScheme).toBe('dark')

    // Create a new store — should read persisted value
    const store2 = createColorSchemeStore()
    expect(store2.getState().colorScheme).toBe('dark')
  })

  it('should persist with custom storage key', () => {
    const store = createColorSchemeStore({ storageKey: 'custom-key' })
    store.getState().setColorScheme('light')

    // New store with same key should read persisted value
    const store2 = createColorSchemeStore({ storageKey: 'custom-key' })
    expect(store2.getState().colorScheme).toBe('light')

    // New store with default key should NOT see the custom key value
    const store3 = createColorSchemeStore()
    expect(store3.getState().colorScheme).toBe('system')
  })

  it('should ignore invalid persisted values', () => {
    // Manually write an invalid value to MMKV
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MMKV } = require('react-native-mmkv') as { MMKV: new () => { set: (k: string, v: string) => void } }
    const mmkv = new MMKV()
    mmkv.set('@mongrov/color-scheme', 'invalid-value')

    const store = createColorSchemeStore()
    expect(store.getState().colorScheme).toBe('system')
  })
})
