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
  useCollection,
  useDatabase,
  useDocument,
  useQuery,
} from './hooks'
export type {
  DatabaseProviderProps,
  DocumentResult,
  QueryResult,
} from './hooks'

// Replication
export {
  cancelReplication,
  createReplicationState,
  resyncReplication,
} from './replication'

// Types — re-exported for convenience so consumers can import everything from
// the engine subpath without dipping into the root entry.
export type {
  CollectionConfig,
  DatabaseConfig,
  DBLogger,
  MangoQueryType,
  MigrationStrategies,
  MigrationStrategy,
  ReplicationCheckpoint,
  ReplicationConfig,
  ReplicationPullHandler,
  ReplicationPushHandler,
  RxCollectionType,
  RxDatabaseType,
  RxDocumentType,
  RxJsonSchemaType,
  RxReplicationStateType,
  RxStorageType,
} from './types'
