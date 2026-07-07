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
import { executeQuery, runAuthorize } from './dispatcher'
import { DataAccessError } from './errors'
import type {
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
      error: rxState.error,
      refetch,
      isStale: false,
    }
  }

  return {
    data: query.data,
    loading: query.isPending,
    error: query.error ?? null,
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
      await runAuthorize(def.config.authorize, parsedInput, ctx)
      const raw = await def.config.exec(parsedInput, ctx)
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
        runtime.bus.emit(pattern, undefined)
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
