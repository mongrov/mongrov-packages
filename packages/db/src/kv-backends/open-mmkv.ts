/**
 * Open an MMKV instance on whichever react-native-mmkv major is installed.
 *
 * v4 dropped the `MMKV` class for a `createMMKV` factory and renamed
 * `delete` to `remove`. `new MMKV()` on v4 throws, and this package used to
 * catch that and keep going on an in-memory map: every write reported success
 * and was gone on the next launch (mongrov-packages#34). Both shapes are
 * supported here, behind the v3 method names the backend already uses.
 */

/** The slice of an MMKV instance the KV backend uses. */
export interface MMKVStorage {
  getString: (key: string) => string | undefined
  set: (key: string, value: string) => void
  delete: (key: string) => void
  getAllKeys: () => string[]
  clearAll: () => void
}

interface MMKVv4 extends Omit<MMKVStorage, 'delete'> {
  remove: (key: string) => boolean
}

interface MMKVModule {
  createMMKV?: (config?: { id: string }) => MMKVv4
  MMKV?: new (config?: { id: string }) => MMKVStorage
}

export function openMMKV(id?: string): MMKVStorage {
  const mod = require('react-native-mmkv') as MMKVModule
  const config = id === undefined ? undefined : { id }
  if (typeof mod.createMMKV === 'function') {
    const mmkv = mod.createMMKV(config)
    return {
      getString: key => mmkv.getString(key),
      set: (key, value) => mmkv.set(key, value),
      delete: (key) => { mmkv.remove(key) },
      getAllKeys: () => mmkv.getAllKeys(),
      clearAll: () => mmkv.clearAll(),
    }
  }
  if (typeof mod.MMKV === 'function')
    return new mod.MMKV(config)
  throw new Error('react-native-mmkv exports neither createMMKV (v4) nor MMKV (v3)')
}
