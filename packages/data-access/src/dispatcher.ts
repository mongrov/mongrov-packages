/**
 * Engine dispatcher (T-06 · T-07 · T-08).
 *
 * `executeQuery` resolves a registered query definition against a set of
 * engine adapters and returns typed output. This is the read-path used
 * both by useAppQuery (arriving in a later task) and by direct callers
 * that want dispatcher semantics without React.
 *
 * Concerns wired here:
 *
 *   - T-06 — dispatch by `def.config.engine`
 *   - T-07 — run `authorize` gate before execution
 *   - T-08 — merge tenant pair into DuckDB params
 *
 * Engines are provided as adapter objects (see EngineAdapters below).
 * The dispatcher never imports @mongrov/analytics or @mongrov/db.
 */

import type { z } from 'zod'

import type { QueryInstrumentation } from './instrumentation'

import type {
  DuckdbQueryConfig,
  KvQueryConfig,
  QueryConfig,
  QueryDefinition,
  RequestContext,
  RxdbQueryConfig,
} from './types'
import {
  AuthorizationError,
  DataAccessError,
} from './errors'
import { mergeTenantParams } from './tenant'

/**
 * T-35 — request handed to DuckdbEngine.fetchOnDemand when a query
 * executes with effective asyncFetch true (principle 57). The package
 * cannot know table/metric hints, so it passes the registry query name +
 * raw input; the app-side adapter (backed by @mongrov/analytics/sync
 * `fetchOnDemand({userId, metric, dateRange})`) maps those to a metric +
 * date range.
 */
export interface FetchOnDemandRequest {
  /** Registry name of the executing query (e.g. "spo2.month"). */
  query: string
  /** The caller's raw input — carries days / offset / dateRange fields. */
  input: unknown
  /** Requester identity from the active RequestContext. */
  userId: string
  /** Convenience extraction of a numeric `input.days`, when present. */
  days?: number
}

/**
 * DuckDB adapter — analytics engine surface consumed by the dispatcher.
 *
 * `dismissInsight` is optional: apps that use the insight-dismissal
 * mutation flow supply it (backed by @mongrov/analytics/core); the
 * MutationContext throws `engine_missing` at call time when absent.
 *
 * `fetchOnDemand` is optional: apps that serve >retention ranges from R2
 * supply it. When absent, asyncFetch-effective queries run local-only and
 * the hook's `fetching` state stays false.
 */
export interface DuckdbEngine {
  execute: (sql: string, params: Record<string, unknown>) => Promise<unknown>
  dismissInsight?: (args: {
    insightId: string
    userId: string
  }) => Promise<void>
  fetchOnDemand?: (request: FetchOnDemandRequest) => Promise<void>
}

/**
 * RxDB adapter — the app-provided runner takes the raw QueryConfig and
 * caller input, executes `config.query(db, input)`, converts the returned
 * Observable to a promise (`firstValueFrom`), and yields the first value.
 *
 * This keeps rxjs out of the data-access peer graph — the adapter is
 * responsible for the rxjs boundary.
 */
export interface RxdbEngine {
  db: unknown
  execute: <TInput>(
    config: RxdbQueryConfig<TInput, unknown>,
    input: TInput,
  ) => Promise<unknown>
}

/**
 * KV adapter — the dispatcher builds the key via `config.keyBuilder(input)`
 * and reads through the app-provided store. `set` / `delete` are optional
 * write surfaces used only by the MutationContext; when absent, mutation
 * writes throw `engine_missing` at call time.
 */
export interface KvEngine {
  get: (key: string) => Promise<unknown> | unknown
  set?: (key: string, value: unknown) => Promise<void> | void
  delete?: (key: string) => Promise<void> | void
}

/**
 * Concrete engine bundle. Any subset may be omitted; the dispatcher
 * throws `engine_missing` if a query targets an omitted engine.
 */
export interface EngineAdapters {
  duckdb?: DuckdbEngine
  rxdb?: RxdbEngine
  kv?: KvEngine
}

/**
 * Optional per-execution instrumentation (Sprint 5 T-45). Off by default;
 * see `instrumentation.ts` for why the measurement exists.
 */
export interface ExecuteQueryOptions {
  instrumentation?: QueryInstrumentation
  /** Registry name, used as the metric key. */
  queryName?: string
}

/**
 * T-06 core — resolve a registered query and return typed output.
 */
export async function executeQuery<TInput, TOutput>(
  def: QueryDefinition<TInput, TOutput>,
  input: TInput,
  ctx: RequestContext,
  engines: EngineAdapters,
  options: ExecuteQueryOptions = {},
): Promise<TOutput> {
  const parsedInput = parseInput(def.config.input, input)

  await runAuthorize(def.config.authorize, parsedInput, ctx)

  // Only the engine round-trip is timed. Input parse, authorize and output
  // parse are ours and roughly constant; folding them in would blur the
  // number the watermark-cache gate is read from.
  const instrumentation = options.instrumentation
  const raw = instrumentation?.enabled && options.queryName
    ? await instrumentation.measure(options.queryName, () =>
        dispatchByEngine(def.config, parsedInput, ctx, engines))
    : await dispatchByEngine(def.config, parsedInput, ctx, engines)

  // Derivation sits between the engine and the parse, so `output`
  // describes the derived shape. Not timed: it is pure TypeScript, and
  // folding it into the latency figure would blur the engine measurement
  // the watermark-cache gate reads.
  const derived = applyTransform(def.config, parsedInput, ctx, raw)

  return parseOutput(def.config.output, derived)
}

/**
 * Run a query's `transform`, if it has a callable one.
 *
 * A string `transform` is registry metadata and is deliberately ignored —
 * see the field's doc comment. A throwing transform surfaces as
 * `transform_failed` rather than a raw exception, so a derivation bug is
 * distinguishable from an engine or schema failure in the hook's `error`.
 */
function applyTransform<TInput, TOutput>(
  config: QueryConfig<TInput, TOutput>,
  input: TInput,
  ctx: RequestContext,
  raw: unknown,
): unknown {
  const transform = 'transform' in config ? config.transform : undefined
  if (typeof transform !== 'function')
    return raw
  try {
    return transform(raw, { ...ctx, input })
  }
  catch (cause) {
    throw new DataAccessError(
      'transform_failed',
      `transform threw: ${(cause as Error).message}`,
      cause,
    )
  }
}

function parseInput<TInput>(
  schema: z.ZodType<TInput> | undefined,
  input: TInput,
): TInput {
  if (!schema)
    return input
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new DataAccessError(
      'zod_parse_failed',
      `input failed schema validation: ${result.error.message}`,
      result.error,
    )
  }
  return result.data
}

function parseOutput<TOutput>(
  schema: z.ZodType<TOutput>,
  raw: unknown,
): TOutput {
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new DataAccessError(
      'zod_parse_failed',
      `output failed schema validation: ${result.error.message}`,
      result.error,
    )
  }
  return result.data
}

/**
 * T-07 — authorization gate. Runs the definition's `authorize` if
 * present; a `false` result throws `AuthorizationError`.
 */
export async function runAuthorize<TInput>(
  authorize:
    | ((input: TInput, ctx: RequestContext) => boolean | Promise<boolean>)
    | undefined,
  input: TInput,
  ctx: RequestContext,
): Promise<void> {
  if (!authorize)
    return
  const allowed = await Promise.resolve(authorize(input, ctx))
  if (!allowed) {
    throw new AuthorizationError('authorization denied by query authorize hook')
  }
}

async function dispatchByEngine<TInput, TOutput>(
  config: QueryDefinition<TInput, TOutput>['config'],
  input: TInput,
  ctx: RequestContext,
  engines: EngineAdapters,
): Promise<unknown> {
  switch (config.engine) {
    case 'duckdb':
      return dispatchDuckdb(config, input, ctx, engines.duckdb)
    case 'rxdb':
      return dispatchRxdb(config, input, engines.rxdb)
    case 'kv':
      return dispatchKv(config, input, engines.kv)
    default: {
      const exhaustive: never = config
      throw new DataAccessError(
        'engine_missing',
        `unknown engine: ${JSON.stringify(exhaustive)}`,
      )
    }
  }
}

function dispatchDuckdb<TInput, TOutput>(
  config: DuckdbQueryConfig<TInput, TOutput>,
  input: TInput,
  ctx: RequestContext,
  engine: DuckdbEngine | undefined,
): Promise<unknown> {
  if (!engine) {
    throw new DataAccessError(
      'engine_missing',
      'engine \'duckdb\' is not wired in this dispatcher',
    )
  }
  const params = mergeTenantParams(input, ctx, config.sql)
  return engine.execute(config.sql, params)
}

function dispatchRxdb<TInput, TOutput>(
  config: RxdbQueryConfig<TInput, TOutput>,
  input: TInput,
  engine: RxdbEngine | undefined,
): Promise<unknown> {
  if (!engine) {
    throw new DataAccessError(
      'engine_missing',
      'engine \'rxdb\' is not wired in this dispatcher',
    )
  }
  return engine.execute(config, input)
}

async function dispatchKv<TInput, TOutput>(
  config: KvQueryConfig<TInput, TOutput>,
  input: TInput,
  engine: KvEngine | undefined,
): Promise<unknown> {
  if (!engine) {
    throw new DataAccessError(
      'engine_missing',
      'engine \'kv\' is not wired in this dispatcher',
    )
  }
  const key = config.keyBuilder(input)
  return engine.get(key)
}
