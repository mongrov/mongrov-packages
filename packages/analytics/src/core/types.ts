/**
 * Public type surface for @mongrov/analytics core.
 *
 * Shapes are the minimum required by the T-02 stub API. Concrete
 * semantics land in later phases (engine wrapper T-03, warehouse T-05,
 * machine T-09, factory T-10, retention T-14). Rich unions like
 * MetricId + METRIC_METADATA land in T-07.
 */

// -------------------- primitives --------------------

/** Fire-and-forget unsubscribe. */
export type Unsubscribe = () => void

/** Tenant scope for attach + token contexts. */
export type TenantScope = 'family' | 'org'

/** Machine state per analytics-core/spec.md §State machine. */
export type AnalyticsState =
  | 'idle'
  | 'opening'
  | 'ready'
  | 'attaching'
  | 'attached'
  | 'detaching'
  | 'error'

// -------------------- attach / token --------------------

export interface AttachContext {
  brand: string
  tenantScope: TenantScope
  tenantId: string
  userId: string
}

export interface TokenContext {
  brand: string
  tenantScope: TenantScope
  tenantId: string
}

export interface TokenResponse {
  token: string
  expiresAt: Date
  scopeClaims: {
    brand: string
    tenantScope: TenantScope
    tenantId: string
    permissions: ('read' | 'write')[]
  }
}

export interface TokenVendor {
  fetch(context: TokenContext): Promise<TokenResponse>
}

/** App-provided family membership. Reads Family.memberIds from RxDB in v1. */
export type FamilyMembersProvider = (ctx: {
  brand: string
  familyId: string
}) => Promise<string[]>

// -------------------- logging --------------------

export interface AnalyticsLogger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

// -------------------- storage / event bus (structural, no runtime dep) --------------------

/**
 * Structural KVStore contract used by the analytics package. Kept local so
 * this package does not require a value-level import from @mongrov/db.
 * The app supplies an implementation (typically @mongrov/db KVStore).
 */
export interface KVStore {
  get<T = unknown>(key: string): Promise<T | undefined>
  set<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * Structural EventBus contract from @mongrov/data-access. Optional peer:
 * populated when analytics-sync emits invalidation events. Full glob
 * semantics documented in data-access/spec.md.
 */
export interface EventBus {
  emit<T>(name: string, payload: T): void
  subscribe<T>(name: string, handler: (payload: T) => void): Unsubscribe
  subscribePattern<T>(
    pattern: string,
    handler: (name: string, payload: T) => void
  ): Unsubscribe
}

// -------------------- config --------------------

/**
 * Attach mode — whether to wire a remote R2 Iceberg catalog (`'r2'`) or
 * operate against local DuckDB only (`'local'`). Default `'r2'` for
 * back-compat with 0.4.x consumers.
 *
 * In `'local'` mode:
 * - `iceberg` + `httpfs` extensions are NOT loaded (removes the AWSSDK
 *   / vcpkg build burden on iOS + Android; apps that don't need remote
 *   sync can skip building those extensions entirely).
 * - `attach()` transitions straight to `attached` after ensuring the
 *   local tables exist; no R2 auth handshake, no remote catalog.
 * - `pusher` / `fetcher` in `@mongrov/analytics/sync` are no-ops.
 * - Rules engine still runs on batch (local-only violation detection).
 */
export type AnalyticsMode = 'local' | 'r2'

interface CommonAnalyticsConfig {
  storage: KVStore
  logger?: AnalyticsLogger
  retention: Record<string, { days: number }>
  extensions?: string[]
  dbPath?: string
  duckdb?: { memoryLimit?: string; threads?: string }
  eventBus?: EventBus
}

/**
 * Local-only config. Omits the R2 fields; `mode` is required as the
 * discriminant so consumers explicitly opt in.
 */
export interface LocalAnalyticsConfig extends CommonAnalyticsConfig {
  mode: 'local'
}

/**
 * Remote R2 Iceberg config. `mode` is optional and defaults to `'r2'` for
 * back-compat with 0.4.x call sites that don't set it.
 */
export interface R2AnalyticsConfig extends CommonAnalyticsConfig {
  mode?: 'r2'
  warehouseUriBuilder: (
    brand: string,
    tenantScope: TenantScope,
    tenantId: string
  ) => string
  catalogEndpoint: string
  tokenVendor: TokenVendor
  familyMembersProvider: FamilyMembersProvider
}

export type AnalyticsConfig = LocalAnalyticsConfig | R2AnalyticsConfig

// -------------------- engine + appender --------------------

export interface AnalyticsAppender {
  appendRow(values: unknown[]): void
  flush(): void
  close(): void
}

export interface AnalyticsEngine {
  attach(ctx: AttachContext): Promise<void>
  detach(): Promise<void>
  execute<T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T[]>
  stream<T = unknown>(sql: string, params?: Record<string, unknown>): AsyncIterable<T[]>
  createAppender(table: string): AnalyticsAppender
  readonly state: AnalyticsState
  /** Last machine error surfaced; cleared on successful recovery. */
  readonly lastError: Error | null
  /** Catalog / warehouse secret name for the current attach; undefined when not attached. */
  readonly catalog: string | undefined
  /**
   * Resolved mode — `'local'` if `AnalyticsConfig.mode === 'local'`,
   * `'r2'` otherwise (including undefined for back-compat). Consumers can
   * use this to gate mode-specific work — e.g. `createSyncManager` skips
   * wiring the R2 pusher/fetcher in local mode.
   */
  readonly mode: AnalyticsMode
  subscribe(listener: (s: AnalyticsState) => void): Unsubscribe
  setRetention(days: number): Promise<void>
  /**
   * Return the last successfully-attached ctx (persisted via KVStore) if it
   * was written within the freshness window (24h). Apps may pass the result
   * to `attach()` to auto-restore after a cold start.
   */
  getLastAttach(brand: string): Promise<AttachContext | null>
  close(): Promise<void>
}

// -------------------- insight (row in `insight` table) --------------------

/**
 * Insight row shape as read from the `insight` DuckDB table.
 * The full schema is frozen in T-06 (schemas.ts); this stub matches the
 * columns needed by `useInsight()` in v0.1.0.
 */
export interface Insight {
  id: string
  brand: string
  familyId: string
  userId: string
  ruleId?: string
  severity: 'info' | 'warn' | 'critical'
  observedAt: Date
  observedValue?: number
  thresholdValue?: number
  payload?: Record<string, unknown>
}
