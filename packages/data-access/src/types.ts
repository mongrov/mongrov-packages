/**
 * Public type surface for @mongrov/data-access.
 *
 * v0.1.0-alpha.0 ships type shapes + minimal runtime for the Define API
 * and invalidation bus. Full engine dispatch, hooks, and the ESLint rule
 * land in later tasks.
 *
 * See data-access/spec.md §Define API, §Engine dispatch.
 */

import type { z } from 'zod'

/** Storage engines supported by the dispatcher. */
export type Engine = 'duckdb' | 'rxdb' | 'kv'

/**
 * Injected per-request context. Populated by DataAccessProvider from the
 * active session (see spec.md §Tenant auto-binding).
 */
export interface RequestContext {
  /** Canonical requester identity (spec.md §Tenant auto-binding). */
  userId: string
  /**
   * @deprecated Use `userId`. Kept as a read-only alias so pre-rename
   * consumers keep working; the provider populates both.
   */
  readonly requesterUserId?: string
  brand: string
  familyId: string
  /**
   * IANA timezone of the active session (e.g. "America/New_York").
   * Auto-bound into DuckDB params as `$tz` by mergeTenantParams.
   */
  timezone: string
  now: () => Date
}

/**
 * Unsubscribe handle returned by every subscription API in this package.
 */
export type Unsubscribe = () => void

/**
 * Frozen glob-style event bus.
 * - `*` matches exactly one `:`-delimited segment
 * - `**` matches one or more segments
 * See spec.md §Invalidation event bus for the full matching table.
 */
export interface EventBus {
  emit<T>(name: string, payload: T): void
  subscribe<T>(name: string, handler: (payload: T) => void): Unsubscribe
  subscribePattern<T>(
    pattern: string,
    handler: (name: string, payload: T) => void
  ): Unsubscribe
}

/**
 * Shared fields across all query engines.
 */
interface QueryConfigBase<TInput, TOutput> {
  input?: z.ZodType<TInput>
  output: z.ZodType<TOutput>
  invalidatedBy?: string[]
  authorize?: (
    input: TInput,
    ctx: RequestContext
  ) => boolean | Promise<boolean>
  staleTime?: number
  gcTime?: number
}

export interface DuckdbQueryConfig<TInput, TOutput>
  extends QueryConfigBase<TInput, TOutput> {
  engine: 'duckdb'
  sql: string
  /**
   * Repo-relative path to an app-owned pure post-query derivation module
   * (e.g. "apps/zivaone/src/features/spo2/utils/derive-day.ts").
   * Documentation / registry metadata only — the package never resolves
   * or imports this path at runtime; the app applies the derivation.
   */
  transform?: string
  /**
   * T-34 — explicit background-fetch override (principle 57).
   * When set, it wins outright. When omitted, asyncFetch is inferred per
   * execution: true when the caller's `input.days` is numeric and exceeds
   * the provider's `brandRetentionDays`. See resolveAsyncFetch in ./define.
   */
  asyncFetch?: boolean
}

export interface RxdbQueryConfig<TInput, TOutput>
  extends QueryConfigBase<TInput, TOutput> {
  engine: 'rxdb'
  // Observable<TOutput> — typed as `unknown` so we don't require rxjs as peer.
  query: (db: unknown, input: TInput) => unknown
}

export interface KvQueryConfig<TInput, TOutput>
  extends QueryConfigBase<TInput, TOutput> {
  engine: 'kv'
  keyBuilder: (input: TInput) => string
}

/**
 * Union of engine-specific query configs. Screens supply the appropriate
 * branch; `defineQuery` enforces the required field at runtime as well.
 */
export type QueryConfig<TInput, TOutput> =
  | DuckdbQueryConfig<TInput, TOutput>
  | RxdbQueryConfig<TInput, TOutput>
  | KvQueryConfig<TInput, TOutput>

/**
 * Opaque handle returned by defineQuery. Screens read via
 * useAppQuery(name, input); the registry preserves the phantom I/O types
 * via `__types`.
 */
export interface QueryDefinition<TInput, TOutput> {
  readonly __kind: 'query'
  readonly config: QueryConfig<TInput, TOutput>
  readonly __types?: { input: TInput; output: TOutput }
}

/**
 * Extended context passed to mutation `exec` (spec.md §Tenant
 * auto-binding). Grants engine write access so mutations can cross
 * storage tiers; the surfaces are structural (type-only) so this
 * package never imports @mongrov/analytics or @mongrov/db at runtime.
 * Authorize hooks still receive only RequestContext.
 */
export interface MutationContext extends RequestContext {
  /** KV write access (MMKV/SecureStore via the provider's kv engine). */
  kv: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    delete?(key: string): Promise<void>
  }
  /** Analytics engine access — for internal mutations like dismissInsight. */
  analytics: {
    dismissInsight(args: { insightId: string; userId: string }): Promise<void>
    execute?(sql: string, params?: Record<string, unknown>): Promise<unknown[]>
  }
  /** RxDB write access — for collab mutations. Opaque handle. */
  rxdb?: unknown
  /** Emit an event manually (in addition to auto-emit from `invalidates`). */
  emit(event: string, payload?: unknown): void
}

export interface MutationConfig<TInput, TOutput> {
  input?: z.ZodType<TInput>
  output?: z.ZodType<TOutput>
  exec: (input: TInput, ctx: MutationContext) => Promise<TOutput>
  invalidates?: string[]
  authorize?: (
    input: TInput,
    ctx: RequestContext
  ) => boolean | Promise<boolean>
  optimistic?: (input: TInput, ctx: RequestContext) => TOutput
}

export interface MutationDefinition<TInput, TOutput> {
  readonly __kind: 'mutation'
  readonly config: MutationConfig<TInput, TOutput>
  readonly __types?: { input: TInput; output: TOutput }
}

export interface EventDefinition<TPayload> {
  readonly __kind: 'event'
  readonly __types?: { payload: TPayload }
}

/**
 * App-provided registry object shape. Apps assemble concrete registries
 * (typically `as const`) and pass them to DataAccessProvider.
 */
export interface Registry {
  queries: Record<string, QueryDefinition<unknown, unknown>>
  mutations: Record<string, MutationDefinition<unknown, unknown>>
  /**
   * `undefined` marks an untyped event — a valid registry entry whose
   * name is subscribable but whose payload carries no schema.
   */
  events: Record<string, EventDefinition<unknown> | undefined>
}

/**
 * DataAccessProvider input contract. Consumers pass a registry, an
 * engine adapter bundle (see EngineAdapters in ./dispatcher), and a
 * session-derived RequestContext factory.
 *
 * `engines` is typed as `unknown` here to avoid a circular import with
 * ./dispatcher; the concrete shape is EngineAdapters and provider
 * implementations should cast at the boundary.
 */
export interface DataAccessProviderProps {
  registry: Registry
  engines: unknown
  context: () => RequestContext
  bus?: EventBus
  /**
   * T-34 — brand data-retention horizon in days. Queries whose
   * `input.days` exceeds this are implicitly asyncFetch (principle 57).
   * Omitted → asyncFetch is never inferred (explicit flags still apply).
   */
  brandRetentionDays?: number
  children?: unknown
}
