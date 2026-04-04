/**
 * @mongrov/db
 *
 * Database utilities for @mongrov apps:
 * - KVStore: Unified async key-value storage (MMKV + SecureStore)
 * - TokenStore: Auth token persistence backed by KVStore
 * - RxDB: Document database with reactive queries
 */

// KVStore
export { createKVStore } from './kv-store'

// TokenStore (for @mongrov/auth integration)
export { createTokenStore } from './token-store'
export type { TokenStore } from './token-store'

// RxDB Database
export { createDatabase, destroyDatabase } from './database'
export {
  DatabaseProvider,
  useDatabase,
  useCollection,
  useQuery,
  useDocument,
} from './hooks'
export type {
  DatabaseProviderProps,
  QueryResult,
  DocumentResult,
} from './hooks'

// Replication
export {
  createReplicationState,
  cancelReplication,
  resyncReplication,
} from './replication'

// Types
export type {
  KVStore,
  KVStoreConfig,
  DBLogger,
  DatabaseConfig,
  CollectionConfig,
  MigrationStrategies,
  MigrationStrategy,
  RxStorageType,
  RxJsonSchemaType,
  RxDatabaseType,
  RxCollectionType,
  RxDocumentType,
  MangoQueryType,
  RxReplicationStateType,
  ReplicationCheckpoint,
  ReplicationPushHandler,
  ReplicationPullHandler,
  ReplicationConfig,
} from './types'
