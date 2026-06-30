/**
 * Docs engine subpath: `@mongrov/db/docs`
 *
 * RxDB-backed document database for conversation/message storage and similar
 * offline-first document workloads. Used by `@mongrov/collab` (D4).
 *
 * Apps that don't need RxDB should import from `@mongrov/db/kv` instead.
 * See `features/db/design.md` §2 for the two-engine boundary.
 */

// Database factory
export { createDatabase, destroyDatabase } from './database'

// React hooks
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

// Types — re-exported for convenience so consumers can import everything from
// the engine subpath without dipping into the root entry.
export type {
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
