/**
 * Screen-facing hooks — useAppQuery / useAppMutation / useAppEvent +
 * useRequestContext accessor.
 *
 * v0.1.0-alpha.0:
 *   - useAppQuery (T-11 duckdb, T-12 rxdb, T-13 kv) — TanStack Query
 *     bridge for pull engines; observable→state bridge for rxdb.
 *   - useAppMutation (T-14) — authorize + optimistic + invalidation
 *     with revert-on-failure via cached optimistic snapshot.
 *   - useAppEvent (T-15) and useRequestContext (T-17) unchanged.
 *
 * See data-access/spec.md §Hooks.
 */

import { useMutation, useQuery } from '@tanstack/react-query'
import * as React from 'react'
import type { z } from 'zod'

import { useDataAccessRuntime } from './context'
import { extractInputDays, resolveAsyncFetch } from './define'
import { executeQuery, runAuthorize } from './dispatcher'
import type { EngineAdapters } from './dispatcher'
import { DataAccessError } from './errors'
import { compileGlob } from './invalidation'
import type {
  EventBus,
  MutationContext,
  MutationDefinition,
  QueryDefinition,
  RequestContext,
  RxdbQueryConfig,
} from './types'

/** T-18 — cache defaults per spec §Cache. Per-query overrides win. */
export const DEFAULT_STALE_TIME = 30_000
export const DEFAULT_GC_TIME = 300_000

export interface UseAppQueryResult<TOutput> {
  data: TOutput | undefined
  loading: boolean
  /**
   * T-35 — true only while a >retention background R2 fetch (effective
   * asyncFetch, principle 57) is in flight via the duckdb engine's
   * fetchOnDemand. Local `data` stays visible throughout; screens show a
   * spinner overlay on this flag. Deliberately NOT TanStack's isFetching —
   * ordinary invalidation refetches never set it.
   */
  fetching: boolean
  error: Error | null
  refetch: () => Promise<void>
  isStale: boolean
}

export interface UseAppMutationResult<TInput, TOutput> {
  mutate: (input: TInput) => void
  mutateAsync: (input: TInput) => Promise<TOutput>
  loading: boolean
  error: Error | null
  data: TOutput | undefined
  reset: () => void
}

/**
 * Minimal RxJS-compatible observable shape. Kept local so this package
 * does not require rxjs as a peer.
 */
interface MinimalObservable<T> {
  subscribe(observer: {
    next: (value: T) => void
    error?: (err: unknown) => void
    complete?: () => void
  }): { unsubscribe: () => void }
}

/**
 * T-11 (duckdb) + T-12 (rxdb) + T-13 (kv) — screen-facing query hook.
 *
 * duckdb/kv → TanStack `useQuery` + invalidation subscription.
 * rxdb → observable subscription; each emission is Zod-parsed and
 *        pushed into local state. `refetch` is a no-op (the observable
 *        drives updates).
 */
export function useAppQuery<TInput, TOutput>(
  name: string,
  input?: TInput
): UseAppQueryResult<TOutput> {
  const runtime = useDataAccessRuntime()
  const def = lookupDefinition<QueryDefinition<TInput, TOutput>>(
    runtime.registry.queries,
    'query',
    name
  )
  const engine = def.config.engine
  const isRxdb = engine === 'rxdb'

  const queryKey = React.useMemo(() => [name, input], [name, input])

  // TanStack path — active for duckdb + kv, disabled for rxdb.
  const query = useQuery<TOutput, Error>({
    queryKey,
    queryFn: () =>
      executeQuery(def, input as TInput, runtime.getContext(), runtime.engines),
    enabled: !isRxdb,
    staleTime: def.config.staleTime ?? DEFAULT_STALE_TIME,
    gcTime: def.config.gcTime ?? DEFAULT_GC_TIME,
  })

  // rxdb path — external state driven by observable emissions.
  const [rxState, setRxState] = React.useState<{
    data: TOutput | undefined
    loading: boolean
    error: Error | null
  }>({ data: undefined, loading: true, error: null })

  React.useEffect(() => {
    if (!isRxdb) return

    const rxEngine = runtime.engines.rxdb
    if (!rxEngine) {
      setRxState({
        data: undefined,
        loading: false,
        error: new DataAccessError(
          'engine_missing',
          "engine 'rxdb' is not wired in this dispatcher"
        ),
      })
      return
    }

    const observable = (def.config as RxdbQueryConfig<TInput, TOutput>).query(
      rxEngine.db,
      input as TInput
    ) as MinimalObservable<unknown>

    let cancelled = false
    const sub = observable.subscribe({
      next: (value) => {
        if (cancelled) return
        const parsed = def.config.output.safeParse(value)
        if (parsed.success) {
          setRxState({
            data: parsed.data as TOutput,
            loading: false,
            error: null,
          })
        } else {
          setRxState({
            data: undefined,
            loading: false,
            error: new DataAccessError(
              'zod_parse_failed',
              `query "${name}" output failed schema validation: ${parsed.error.message}`,
              parsed.error
            ),
          })
        }
      },
      error: (err) => {
        if (cancelled) return
        setRxState({
          data: undefined,
          loading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      },
    })

    return () => {
      cancelled = true
      sub.unsubscribe()
    }
  }, [runtime, def, input, isRxdb, name])

  // T-34/T-35 — background on-demand fetch for >retention ranges
  // (principle 57). Effective asyncFetch: explicit config flag wins;
  // otherwise inferred from input.days vs the provider's
  // brandRetentionDays. duckdb-only — the R2 fetch lands rows in DuckDB.
  const asyncFetchEffective =
    engine === 'duckdb' &&
    resolveAsyncFetch(def.config, input, runtime.brandRetentionDays)

  const [onDemand, setOnDemand] = React.useState<{
    fetching: boolean
    error: Error | null
  }>({ fetching: false, error: null })

  React.useEffect(() => {
    if (!asyncFetchEffective) return
    const fetchOnDemand = runtime.engines.duckdb?.fetchOnDemand
    // No R2 path wired → local-only serve; fetching stays false.
    if (!fetchOnDemand) return

    let cancelled = false
    setOnDemand({ fetching: true, error: null })
    const ctx = runtime.getContext()

    Promise.resolve(
      fetchOnDemand({
        query: name,
        input,
        userId: ctx.userId,
        days: extractInputDays(input),
      })
    )
      .then(async () => {
        // Fetched rows landed in local DuckDB — refetch so the query
        // picks them up. TanStack keeps previous data visible during the
        // refetch, so `data` never disappears.
        await runtime.queryClient.invalidateQueries({ queryKey: [name] })
        if (!cancelled) setOnDemand({ fetching: false, error: null })
      })
      .catch((err: unknown) => {
        // Failure surfaces via `error` while local data stays served.
        if (!cancelled) {
          setOnDemand({
            fetching: false,
            error: err instanceof Error ? err : new Error(String(err)),
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [asyncFetchEffective, runtime, name, input])

  // Invalidation subscriptions — TanStack path only. rxdb self-updates
  // via the observable stream.
  const patterns = def.config.invalidatedBy
  React.useEffect(() => {
    if (isRxdb) return
    if (!patterns || patterns.length === 0) return
    const unsubs = patterns.map((pattern) =>
      runtime.bus.subscribePattern(pattern, () => {
        runtime.queryClient.invalidateQueries({ queryKey: [name] })
      })
    )
    return () => {
      for (const off of unsubs) off()
    }
  }, [runtime.bus, runtime.queryClient, name, patterns, isRxdb])

  const refetch = React.useCallback(async () => {
    if (isRxdb) return
    await query.refetch()
  }, [isRxdb, query])

  if (isRxdb) {
    return {
      data: rxState.data,
      loading: rxState.loading,
      fetching: false,
      error: rxState.error,
      refetch,
      isStale: false,
    }
  }

  return {
    data: query.data,
    loading: query.isPending,
    fetching: onDemand.fetching,
    error: query.error ?? onDemand.error ?? null,
    refetch,
    isStale: query.isStale,
  }
}

/**
 * T-14 — screen-facing mutation hook.
 *
 * Runs authorize + exec (via the app-provided config) through TanStack
 * useMutation. On success, emits each `invalidates` entry on the event
 * bus so subscribing queries invalidate their caches. If `optimistic`
 * is defined, the returned `data` reflects the optimistic value while
 * the mutation is pending and reverts on failure.
 */
export function useAppMutation<TInput, TOutput>(
  name: string
): UseAppMutationResult<TInput, TOutput> {
  const runtime = useDataAccessRuntime()
  const def = lookupDefinition<MutationDefinition<TInput, TOutput>>(
    runtime.registry.mutations,
    'mutation',
    name
  )

  const [optimisticValue, setOptimisticValue] = React.useState<
    TOutput | undefined
  >(undefined)

  const mutation = useMutation<TOutput, Error, TInput>({
    mutationFn: async (input: TInput) => {
      const ctx = runtime.getContext()
      const parsedInput = parseWithSchema(
        def.config.input,
        input,
        'input',
        name
      )
      // Authorize sees only the read context; exec gets the extended
      // MutationContext with engine write access (spec §Mutation flow).
      await runAuthorize(def.config.authorize, parsedInput, ctx)
      const mutationCtx = buildMutationContext(
        ctx,
        runtime.engines,
        runtime.bus
      )
      const raw = await def.config.exec(parsedInput, mutationCtx)
      return parseWithSchema(def.config.output, raw, 'output', name)
    },
    onMutate: (input) => {
      if (!def.config.optimistic) return undefined
      const ctx = runtime.getContext()
      const value = def.config.optimistic(input, ctx)
      setOptimisticValue(value)
      return undefined
    },
    onSuccess: () => {
      const patterns = def.config.invalidates ?? []
      for (const pattern of patterns) {
        if (pattern.includes('*')) {
          // Glob entry (principle 49 semantics via compileGlob): match it
          // against the literal event names queries subscribed with, and
          // invalidate those caches directly. Emitting the glob string as
          // a literal event would never match any subscription, so we
          // deliberately do not emit it.
          const regex = compileGlob(pattern)
          for (const [queryName, queryDef] of Object.entries(
            runtime.registry.queries
          )) {
            const subscribed = queryDef.config.invalidatedBy ?? []
            const hit = subscribed.some(
              (event) => !event.includes('*') && regex.test(event)
            )
            if (hit) {
              runtime.queryClient.invalidateQueries({ queryKey: [queryName] })
            }
          }
        }
        else {
          runtime.bus.emit(pattern, undefined)
        }
      }
    },
    onSettled: () => {
      // Clear the optimistic snapshot so subsequent mutations start
      // clean. On failure this achieves the "revert" — mutation.data
      // returns to undefined and the optimistic layer disappears.
      setOptimisticValue(undefined)
    },
  })

  const data =
    mutation.isPending && optimisticValue !== undefined
      ? optimisticValue
      : mutation.data

  return {
    mutate: mutation.mutate,
    mutateAsync: mutation.mutateAsync,
    loading: mutation.isPending,
    error: mutation.error ?? null,
    data,
    reset: mutation.reset,
  }
}

/**
 * T-15 — subscribe to a named event for the lifetime of the mounting
 * component. Handler runs on every emit whose name matches exactly; use
 * the pattern form (bus.subscribePattern) directly for glob semantics.
 *
 * The handler ref is kept fresh so callers may pass unstable closures
 * without churning the subscription.
 */
export function useAppEvent<TPayload>(
  name: string,
  handler: (payload: TPayload) => void
): void {
  const runtime = useDataAccessRuntime()
  const handlerRef = React.useRef(handler)

  React.useEffect(() => {
    handlerRef.current = handler
  }, [handler])

  React.useEffect(() => {
    const off = runtime.bus.subscribe<TPayload>(name, (payload) => {
      handlerRef.current(payload)
    })
    return off
  }, [runtime.bus, name])
}

/**
 * T-17 — read the current session's RequestContext from the provider.
 * The provider's `context` callback is invoked on every read so
 * callers pick up session updates without re-mounting.
 */
export function useRequestContext(): RequestContext {
  const runtime = useDataAccessRuntime()
  return runtime.getContext()
}

// --- helpers ---------------------------------------------------------

/**
 * Assemble the MutationContext handed to `exec` from the provider's
 * engine adapters + RequestContext + event bus. Engine surfaces are
 * wrapped lazily: a mutation only pays for (and can only fail on) the
 * engines it actually touches — a missing engine throws `engine_missing`
 * at call time, not at context construction.
 */
function buildMutationContext(
  ctx: RequestContext,
  engines: EngineAdapters,
  bus: EventBus
): MutationContext {
  const kv = engines.kv
  const analytics = engines.duckdb

  return {
    ...ctx,
    kv: {
      async get(key: string): Promise<unknown> {
        if (!kv) throw missingMutationEngine('kv', 'get')
        return kv.get(key)
      },
      async set(key: string, value: unknown): Promise<void> {
        if (!kv?.set) throw missingMutationEngine('kv', 'set')
        await kv.set(key, value)
      },
      async delete(key: string): Promise<void> {
        if (!kv?.delete) throw missingMutationEngine('kv', 'delete')
        await kv.delete(key)
      },
    },
    analytics: {
      async dismissInsight(args: {
        insightId: string
        userId: string
      }): Promise<void> {
        if (!analytics?.dismissInsight) {
          throw missingMutationEngine('duckdb', 'dismissInsight')
        }
        await analytics.dismissInsight(args)
      },
      async execute(
        sql: string,
        params?: Record<string, unknown>
      ): Promise<unknown[]> {
        if (!analytics) throw missingMutationEngine('duckdb', 'execute')
        const rows = await analytics.execute(sql, params ?? {})
        return Array.isArray(rows) ? rows : [rows]
      },
    },
    rxdb: engines.rxdb?.db,
    emit: (event: string, payload?: unknown) => bus.emit(event, payload),
  }
}

function missingMutationEngine(
  engine: 'kv' | 'duckdb',
  method: string
): DataAccessError {
  return new DataAccessError(
    'engine_missing',
    `mutation context: engine '${engine}' does not provide ${method}() ` +
      'in this dispatcher'
  )
}

function lookupDefinition<T>(
  bag: Record<string, unknown>,
  label: 'query' | 'mutation',
  name: string
): T {
  const def = bag[name]
  if (!def) {
    throw new DataAccessError(
      'engine_missing',
      `no ${label} named "${name}" is registered`
    )
  }
  return def as T
}

function parseWithSchema<T>(
  schema: z.ZodType<T> | undefined,
  value: unknown,
  side: 'input' | 'output',
  name: string
): T {
  if (!schema) return value as T
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new DataAccessError(
      'zod_parse_failed',
      `mutation "${name}" ${side} failed schema validation: ${result.error.message}`,
      result.error
    )
  }
  return result.data
}

/**
 * Input type a `defineQuery` was declared with.
 *
 * Both parameters are inferred, not just the one being read. Matching on
 * `QueryDefinition<infer I, unknown>` fails: the output position is not
 * covariant, so a concrete definition does not extend it and the conditional
 * silently resolves to `never` — which then accepts nothing and looks like a
 * working constraint until you assign something valid.
 */
export type QueryInputOf<T> = T extends QueryDefinition<infer I, infer _O> ? I : never
/** Output type a `defineQuery` was declared with. See `QueryInputOf`. */
export type QueryOutputOf<T> = T extends QueryDefinition<infer _I, infer O> ? O : never

/**
 * Registry-typed hooks.
 *
 * `useAppQuery` is generic over `<TInput, TOutput>` that the CALLER supplies,
 * so it believes whatever the call site asserts. That is not a hypothetical
 * problem: zivaone_app annotated `user.spo2SafeLevel` as `{ value: number }`
 * when the query returns a bare `number`, read `.data?.value`, got `undefined`
 * forever, and silently fell back to a default of 90. It compiled, it never
 * threw, and no test caught it — the shape was asserted, not checked.
 *
 * These hooks take the query NAME and derive both types from the registry
 * entry, so a wrong annotation is not expressible. Wire them once:
 *
 * ```ts
 * // src/data/hooks.ts
 * export const { useAppQuery } = createRegistryHooks<typeof registry.queries>()
 * ```
 *
 * The untyped `useAppQuery` remains exported and unchanged — the `Registry`
 * interface erases variance, so a registry cannot be typed at the provider
 * boundary without breaking every existing consumer.
 */
export function createRegistryHooks<
  TQueries extends Record<string, QueryDefinition<never, unknown>>,
>() {
  return {
    useAppQuery<TName extends keyof TQueries & string>(
      name: TName,
      input?: QueryInputOf<TQueries[TName]>,
    ): UseAppQueryResult<QueryOutputOf<TQueries[TName]>> {
      return useAppQuery(name, input) as UseAppQueryResult<
        QueryOutputOf<TQueries[TName]>
      >
    },
  }
}
