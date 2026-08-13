/**
 * React hooks over the analytics engine.
 *
 * All three hooks resolve the engine via `useAnalyticsEngine()` (context) and
 * subscribe to state transitions with `useSyncExternalStore`. Query hooks
 * (`useTimeseries`, `useInsight`) block until the engine is attached; a
 * detach + re-attach (family switch) refires them via the state subscription.
 */

import type { AnalyticsEngine, AnalyticsState, Insight } from './types'

import { useCallback, useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react'
import { useAnalyticsEngine } from './context'
import { quoteQualifier } from './schemas'

// -------------------- useAnalytics --------------------

export interface UseAnalyticsResult {
  state: AnalyticsState
  isReady: boolean
  isAttached: boolean
  error: Error | null
}

/**
 * Subscribe to the engine's state machine. Re-renders on every transition.
 * `isReady` is true from `ready` onward (engine opened); `isAttached` is true
 * only in the `attached` state.
 */
export function useAnalytics(): UseAnalyticsResult {
  const engine = useAnalyticsEngine()
  const state = useEngineState(engine)
  return {
    state,
    isReady: state !== 'idle' && state !== 'opening' && state !== 'error',
    isAttached: state === 'attached',
    error: state === 'error' ? engine.lastError : null,
  }
}

// -------------------- useTimeseries --------------------

export interface UseTimeseriesResult<T> {
  data: T[] | undefined
  loading: boolean
  error: Error | null
  refetch: () => Promise<void>
}

interface TimeseriesState<T> {
  data: T[] | undefined
  loading: boolean
  error: Error | null
}

type TimeseriesAction<T>
  = | { type: 'start' }
    | { type: 'success', data: T[] }
    | { type: 'failure', error: Error }
    | { type: 'reset' }

function timeseriesReducer<T>(
  state: TimeseriesState<T>,
  action: TimeseriesAction<T>,
): TimeseriesState<T> {
  switch (action.type) {
    case 'start':
      return { ...state, loading: true, error: null }
    case 'success':
      return { data: action.data, loading: false, error: null }
    case 'failure':
      return { ...state, loading: false, error: action.error }
    case 'reset':
      return { data: undefined, loading: false, error: null }
  }
}

/**
 * Runs `sql` (with `params`) against the engine whenever `key`, `sql`,
 * `params`, or the engine's attached state changes. `key === undefined`
 * disables the query (data stays `undefined`).
 *
 * `refetch()` re-runs the current query; stale results from prior effects are
 * discarded via a per-effect abort flag so out-of-order responses never win.
 */
export function useTimeseries<T = unknown>(
  key: string | undefined,
  sql: string,
  params?: Record<string, unknown>,
): UseTimeseriesResult<T> {
  const engine = useAnalyticsEngine()
  const state = useEngineState(engine)
  const attached = state === 'attached'

  // Stable string key for params so effect deps don't retrigger on new refs.
  const paramsKey = useMemo(() => (params ? stableJson(params) : ''), [params])

  const [store, dispatch] = useReducer(
    timeseriesReducer as (
      s: TimeseriesState<T>,
      a: TimeseriesAction<T>,
    ) => TimeseriesState<T>,
    { data: undefined, loading: false, error: null } as TimeseriesState<T>,
  )

  // Keep the latest params ref so refetch uses fresh values without re-arming
  // the effect (params object identity changes on every render).
  const latestParamsRef = useRef(params)
  latestParamsRef.current = params

  const runQuery = useCallback(
    async (abortRef: { aborted: boolean }): Promise<void> => {
      dispatch({ type: 'start' })
      try {
        const rows = await engine.execute<T>(sql, latestParamsRef.current)
        if (abortRef.aborted)
          return
        dispatch({ type: 'success', data: rows })
      }
      catch (cause) {
        if (abortRef.aborted)
          return
        dispatch({
          type: 'failure',
          error: cause instanceof Error ? cause : new Error(String(cause)),
        })
      }
    },
    [engine, sql],
  )

  // Track the currently active abort ref so `refetch()` can invalidate the
  // background effect run without waiting for the deps to change.
  const activeAbortRef = useRef<{ aborted: boolean } | null>(null)

  useEffect(() => {
    if (key === undefined) {
      dispatch({ type: 'reset' })
      return
    }
    if (!attached) {
      // Waiting for engine to attach; leave `data` as-is and don't set loading.
      return
    }
    const abortRef = { aborted: false }
    activeAbortRef.current = abortRef
    void runQuery(abortRef)
    return () => {
      abortRef.aborted = true
      if (activeAbortRef.current === abortRef) {
        activeAbortRef.current = null
      }
    }
    // paramsKey is a stable stringified marker; sql + key + attached round out deps.
  }, [key, sql, paramsKey, attached, runQuery])

  const refetch = useCallback(async (): Promise<void> => {
    if (key === undefined || !attached)
      return
    // Cancel any in-flight query so its result can't overwrite ours.
    if (activeAbortRef.current) {
      activeAbortRef.current.aborted = true
    }
    const abortRef = { aborted: false }
    activeAbortRef.current = abortRef
    await runQuery(abortRef)
  }, [key, attached, runQuery])

  return { data: store.data, loading: store.loading, error: store.error, refetch }
}

// -------------------- useInsight --------------------

export interface UseInsightResult {
  insight: Insight | undefined
  loading: boolean
}

/**
 * Reads a single insight row by id. Returns `undefined` if the engine is not
 * attached or the row does not exist.
 */
export function useInsight(id: string): UseInsightResult {
  const engine = useAnalyticsEngine()
  const catalog = engine.catalog
  const sql = catalog
    ? `SELECT * FROM ${quoteQualifier(catalog)}.insight WHERE insight_id = $id LIMIT 1`
    : ''
  const params = useMemo(() => ({ id }), [id])
  const { data, loading } = useTimeseries<Insight>(
    catalog ? id : undefined,
    sql,
    params,
  )
  return {
    insight: data?.[0],
    loading,
  }
}

// -------------------- internal --------------------

/** `useSyncExternalStore` bound to the engine's subscribe surface. */
function useEngineState(engine: AnalyticsEngine): AnalyticsState {
  return useSyncExternalStore(
    useCallback(
      onStoreChange => engine.subscribe(onStoreChange),
      [engine],
    ),
    useCallback(() => engine.state, [engine]),
    useCallback(() => engine.state, [engine]),
  )
}

/**
 * Deterministic JSON for effect-dep keys. Object.keys() order is
 * insertion-defined in modern engines; we sort to be safe when apps compute
 * params objects with varying key order.
 */
function stableJson(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort()
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = value[k]
  return JSON.stringify(out)
}
