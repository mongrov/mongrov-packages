/**
 * KVStore-only exports (no RxDB dependency)
 *
 * Use this entry point if you only need KVStore without RxDB:
 * import { createKVStore } from '@mongrov/db/kv'
 */

// KVStore
export { createKVStore } from './kv-store'

// TokenStore (for @mongrov/auth integration)
export { createTokenStore } from './token-store'
export type { TokenStore } from './token-store'

// Types
export type { KVStore, KVStoreConfig } from './types'
