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
  requesterUserId: string
  brand: string
  familyId: string
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

export interface MutationConfig<TInput, TOutput> {
  input?: z.ZodType<TInput>
  output?: z.ZodType<TOutput>
  exec: (input: TInput, ctx: RequestContext) => Promise<TOutput>
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
  events: Record<string, EventDefinition<unknown>>
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
  children?: unknown
}
