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

import {
  AuthorizationError,
  DataAccessError,
} from './errors'
import { mergeTenantParams } from './tenant'
import type {
  DuckdbQueryConfig,
  KvQueryConfig,
  QueryDefinition,
  RequestContext,
  RxdbQueryConfig,
} from './types'

/**
 * DuckDB adapter — analytics engine surface consumed by the dispatcher.
 */
export interface DuckdbEngine {
  execute(sql: string, params: Record<string, unknown>): Promise<unknown>
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
  execute<TInput>(
    config: RxdbQueryConfig<TInput, unknown>,
    input: TInput
  ): Promise<unknown>
}

/**
 * KV adapter — the dispatcher builds the key via `config.keyBuilder(input)`
 * and reads through the app-provided store.
 */
export interface KvEngine {
  get(key: string): Promise<unknown> | unknown
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
 * T-06 core — resolve a registered query and return typed output.
 */
export async function executeQuery<TInput, TOutput>(
  def: QueryDefinition<TInput, TOutput>,
  input: TInput,
  ctx: RequestContext,
  engines: EngineAdapters
): Promise<TOutput> {
  const parsedInput = parseInput(def.config.input, input)

  await runAuthorize(def.config.authorize, parsedInput, ctx)

  const raw = await dispatchByEngine(def.config, parsedInput, ctx, engines)

  return parseOutput(def.config.output, raw)
}

function parseInput<TInput>(
  schema: z.ZodType<TInput> | undefined,
  input: TInput
): TInput {
  if (!schema) return input
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new DataAccessError(
      'zod_parse_failed',
      `input failed schema validation: ${result.error.message}`,
      result.error
    )
  }
  return result.data
}

function parseOutput<TOutput>(
  schema: z.ZodType<TOutput>,
  raw: unknown
): TOutput {
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new DataAccessError(
      'zod_parse_failed',
      `output failed schema validation: ${result.error.message}`,
      result.error
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
  ctx: RequestContext
): Promise<void> {
  if (!authorize) return
  const allowed = await Promise.resolve(authorize(input, ctx))
  if (!allowed) {
    throw new AuthorizationError('authorization denied by query authorize hook')
  }
}

async function dispatchByEngine<TInput, TOutput>(
  config: QueryDefinition<TInput, TOutput>['config'],
  input: TInput,
  ctx: RequestContext,
  engines: EngineAdapters
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
        `unknown engine: ${JSON.stringify(exhaustive)}`
      )
    }
  }
}

function dispatchDuckdb<TInput, TOutput>(
  config: DuckdbQueryConfig<TInput, TOutput>,
  input: TInput,
  ctx: RequestContext,
  engine: DuckdbEngine | undefined
): Promise<unknown> {
  if (!engine) {
    throw new DataAccessError(
      'engine_missing',
      "engine 'duckdb' is not wired in this dispatcher"
    )
  }
  const params = mergeTenantParams(input, ctx)
  return engine.execute(config.sql, params)
}

function dispatchRxdb<TInput, TOutput>(
  config: RxdbQueryConfig<TInput, TOutput>,
  input: TInput,
  engine: RxdbEngine | undefined
): Promise<unknown> {
  if (!engine) {
    throw new DataAccessError(
      'engine_missing',
      "engine 'rxdb' is not wired in this dispatcher"
    )
  }
  return engine.execute(config, input)
}

async function dispatchKv<TInput, TOutput>(
  config: KvQueryConfig<TInput, TOutput>,
  input: TInput,
  engine: KvEngine | undefined
): Promise<unknown> {
  if (!engine) {
    throw new DataAccessError(
      'engine_missing',
      "engine 'kv' is not wired in this dispatcher"
    )
  }
  const key = config.keyBuilder(input)
  return engine.get(key)
}
