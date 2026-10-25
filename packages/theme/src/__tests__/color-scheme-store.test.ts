import { createColorSchemeStore } from '../color-scheme-store'

// Mock is loaded via moduleNameMapper in jest.config.js

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

    const { MMKV } = require('react-native-mmkv') as { MMKV: new () => { set: (k: string, v: string) => void } }
    const mmkv = new MMKV()
    mmkv.set('@mongrov/color-scheme', 'invalid-value')

    const store = createColorSchemeStore()
    expect(store.getState().colorScheme).toBe('system')
  })
})

describe('createColorSchemeStore on each react-native-mmkv major', () => {
  afterEach(() => {
    jest.dontMock('react-native-mmkv')
    jest.resetModules()
  })

  /** A choice made in one store, read by the next: what a relaunch sees. */
  function persistsAcrossStores(mod: object): string {
    jest.resetModules()
    jest.doMock('react-native-mmkv', () => mod)
    const { createColorSchemeStore: create } = require('../color-scheme-store') as typeof import('../color-scheme-store')
    create().getState().setColorScheme('dark')
    return create().getState().colorScheme
  }

  /** One shared map, shaped as each major exposes it. */
  function backing() {
    const map = new Map<string, string>()
    const instance = { getString: (k: string) => map.get(k), set: (k: string, v: string) => { map.set(k, v) } }
    return instance
  }

  it('v4 (createMMKV only — no MMKV class): persists', () => {
    const instance = backing()
    expect(persistsAcrossStores({ createMMKV: () => instance })).toBe('dark')
  })

  it('v3 (MMKV class): persists', () => {
    const instance = backing()
    expect(persistsAcrossStores({ MMKV: function MMKV() { return instance } })).toBe('dark')
  })

  it('no MMKV: still works, unpersisted', () => {
    expect(persistsAcrossStores({})).toBe('system')
  })
})
