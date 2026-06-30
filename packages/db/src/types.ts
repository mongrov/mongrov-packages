/**
 * Type definitions for @mongrov/db
 */

// ─── KVStore ───────────────────────────────────────────────────────────────

/**
 * Unified async key-value store interface.
 * Abstracts over MMKV (fast) and SecureStore (secure).
 */
export interface KVStore {
  /** Get a string value by key */
  get(key: string): Promise<string | null>

  /** Set a string value */
  set(key: string, value: string): Promise<void>

  /** Delete a key */
  delete(key: string): Promise<void>

  /** Get and parse a JSON object */
  getObject<T>(key: string): Promise<T | null>

  /** Stringify and set a JSON object */
  setObject<T>(key: string, value: T): Promise<void>

  /** Clear all keys in this store */
  clear(): Promise<void>

  /** Get all keys (for migration/debugging) */
  getAllKeys(): Promise<string[]>
}

/**
 * Configuration for createKVStore factory.
 */
export interface KVStoreConfig {
  /**
   * Use secure storage (expo-secure-store) instead of MMKV.
   * Use for tokens, secrets, and sensitive data.
   * @default false
   */
  secure?: boolean

  /**
   * MMKV instance ID for isolation between stores.
   * Ignored when secure=true.
   * @default 'mongrov-kv'
   */
  instanceId?: string
}

// ─── Database (RxDB) ───────────────────────────────────────────────────────

/**
 * Logger interface for database operations.
 */
export interface DBLogger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

/**
 * Configuration for createDatabase factory.
 */
export interface DatabaseConfig {
  /** Database name (used for storage identification) */
  name: string

  /**
   * RxDB storage adapter — required, app provides.
   * Examples: getRxStorageSQLite(), getRxStorageMemory()
   */
  storage: RxStorageType

  /** Collection configurations */
  collections: CollectionConfig[]

  /** Optional logger for database operations */
  logger?: DBLogger

  /**
   * Enable multi-instance mode (multiple tabs/processes).
   * Usually false for React Native (single process).
   * @default false
   */
  multiInstance?: boolean

  /**
   * Ignore duplicate database creation errors.
   * Useful during hot reload in development.
   * @default true
   */
  ignoreDuplicate?: boolean
}

/**
 * Configuration for a single collection.
 */
export interface CollectionConfig {
  /** Collection name */
  name: string

  /** RxDB JSON schema for the collection */
  schema: RxJsonSchemaType

  /** Migration strategies for schema version upgrades */
  migrationStrategies?: MigrationStrategies
}

/**
 * Migration strategies keyed by target version number.
 */
export type MigrationStrategies = Record<number, MigrationStrategy>

/**
 * Migration function for a schema version upgrade.
 */
export type MigrationStrategy = (oldDoc: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>

// ─── RxDB Type Aliases ─────────────────────────────────────────────────────
// These are type aliases to avoid hard dependency on rxdb types at compile time.
// The actual types come from rxdb when it's installed.

/** RxDB storage adapter type (from rxdb) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RxStorageType = any

/** RxDB JSON schema type (from rxdb) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RxJsonSchemaType = any

/** RxDB database instance type (from rxdb) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RxDatabaseType = any

/** RxDB collection instance type (from rxdb) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RxCollectionType = any

/** RxDB document instance type (from rxdb) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RxDocumentType = any

/** RxDB query type (from rxdb) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MangoQueryType = any

/** RxDB replication state type (from rxdb) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RxReplicationStateType = any

// ─── Replication ──────────────────────────────────────────────────────────────

/**
 * Checkpoint for tracking sync progress.
 * App defines structure based on backend requirements.
 */
export type ReplicationCheckpoint = Record<string, unknown>

/**
 * Push handler for sending local changes to remote.
 * Called by RxDB when local documents change.
 */
export type ReplicationPushHandler<T = RxDocumentType> = (
  docs: T[]
) => Promise<void>

/**
 * Pull handler for fetching remote changes.
 * Called by RxDB to sync from remote.
 */
export type ReplicationPullHandler<T = RxDocumentType> = (
  checkpoint: ReplicationCheckpoint | null,
  batchSize: number
) => Promise<{
  documents: T[]
  checkpoint: ReplicationCheckpoint | null
}>

// ─── Timeseries (D3 stub) ──────────────────────────────────────────────────
// Port shapes for the timeseries engine. Implementation lands in D3
// (`@mongrov/db/timeseries`); these types ship in D1 so device + app code can
// type against the contract today. See `features/db/design.md` §4.

/**
 * Opaque high-water mark used by timeseries replication to track flush
 * progress. Engine implementations choose the concrete shape (timestamp,
 * monotonic counter, vendor cursor object).
 */
export type TimeseriesHWM = unknown

/**
 * Append-only sink for device readings. Idempotent: implementations dedup on
 * `(deviceId, metric, ts)` so live + backlog overlap collapses to one row.
 * Satisfies `@mongrov/device`'s `ReadingSink` port (see device-design §3).
 */
export interface ReadingSink<TReading = unknown> {
  write(batch: TReading[]): Promise<void>
}

/**
 * Pluggable remote target for either replication direction. The replication
 * machine is engine-agnostic — only the target differs (Postgres/REST for
 * docs; S3-parquet/InfluxDB/HTTP-batch for timeseries).
 */
export interface RemoteTarget<TBatch, THWM = TimeseriesHWM> {
  pull?(since: THWM | null): AsyncIterable<TBatch>
  push?(batch: TBatch): Promise<{ ack: THWM }>
}

/**
 * Pluggable timeseries engine. v1 ships a `TimonEngine` adapter wrapping the
 * native S3-parquet bridge; v2 adds an RxDB-backed fallback. Apps inject one
 * via `<TimeseriesProvider engine={...}>`.
 */
export interface TimeseriesEngine<TReading = unknown> {
  /** Engine identifier for diagnostics (e.g. 'timon', 'rxdb-fallback'). */
  readonly id: string

  /** Append batch to local storage. Idempotent on (deviceId, metric, ts). */
  write(batch: TReading[]): Promise<void>

  /**
   * Range query against local storage. `kind`-aware: engines pick column
   * layout based on the reading kind, but query results are opaque to db.
   */
  query<T = TReading>(args: {
    deviceId?: string
    metric?: string
    from?: number
    to?: number
    limit?: number
  }): Promise<T[]>

  /**
   * Drain a batch of un-flushed readings for replication. Returns the batch
   * + the HWM to record after a successful remote ack.
   */
  drain?(maxBatchSize?: number): Promise<{ batch: TReading[], nextHwm: TimeseriesHWM } | null>

  /** Record the HWM after a successful remote push. */
  advanceHwm?(hwm: TimeseriesHWM): Promise<void>
}

/**
 * Configuration for createReplicationState.
 */
export interface ReplicationConfig<T = RxDocumentType> {
  /** Unique identifier for this replication */
  replicationIdentifier: string

  /** The RxDB collection to replicate */
  collection: RxCollectionType

  /**
   * Push handler — sends local changes to remote.
   * If not provided, push is disabled (pull-only sync).
   */
  push?: {
    handler: ReplicationPushHandler<T>
    /** Batch size for push operations @default 100 */
    batchSize?: number
  }

  /**
   * Pull handler — fetches remote changes.
   * If not provided, pull is disabled (push-only sync).
   */
  pull?: {
    handler: ReplicationPullHandler<T>
    /** Batch size for pull operations @default 100 */
    batchSize?: number
  }

  /**
   * Whether to start replication immediately.
   * @default true
   */
  autoStart?: boolean

  /**
   * Interval in milliseconds between pull cycles.
   * Set to 0 for manual-only sync (use with live streams).
   * @default 0
   */
  retryTime?: number

  /**
   * Enable live replication (real-time sync).
   * When true, replication listens for remote changes via streams.
   * @default false
   */
  live?: boolean

  /** Optional logger for replication events */
  logger?: DBLogger
}
