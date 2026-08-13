/**
 * @mongrov/db — root entry (zero-runtime types barrel)
 *
 * Engine code lives in the subpaths:
 *   @mongrov/db/kv          — KVStore (MMKV + SecureStore). Shipped.
 *   @mongrov/db/docs        — RxDB document database. Used by @mongrov/collab.
 *   @mongrov/db/timeseries  — Append-only device-reading engine. D3.
 *
 * This entry exports **only types** so apps (and other @mongrov/* packages)
 * can declare ports against the contract without pulling any engine runtime.
 * See `features/db/design.md` §1.
 */

// TokenStore type re-exported for @mongrov/auth integration.
export type { TokenStore } from './token-store'

// Cross-engine types (no runtime)
export type {
  CollectionConfig,
  // Docs engine
  DatabaseConfig,
  // Logging
  DBLogger,
  // KV
  KVStore,
  KVStoreConfig,
  MangoQueryType,
  MigrationStrategies,
  MigrationStrategy,
  ReadingSink,
  RemoteTarget,
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
  TimeseriesEngine,
  // Timeseries engine (D3 stub)
  TimeseriesHWM,
} from './types'
