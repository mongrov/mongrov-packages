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

// Cross-engine types (no runtime)
export type {
  // KV
  KVStore,
  KVStoreConfig,
  // Logging
  DBLogger,
  // Docs engine
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
  // Timeseries engine (D3 stub)
  TimeseriesHWM,
  ReadingSink,
  RemoteTarget,
  TimeseriesEngine,
} from './types'

// TokenStore type re-exported for @mongrov/auth integration.
export type { TokenStore } from './token-store'
