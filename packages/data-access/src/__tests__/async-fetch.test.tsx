// @vitest-environment jsdom

// Sprint 5 Phase 7 — T-34 implicit asyncFetch + T-35 `fetching` state
// (spec §8, principle 57).

import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  DataAccessProvider,
  defineQuery,
  resolveAsyncFetch,
  useAppQuery,
} from '../index'
import type { EngineAdapters, FetchOnDemandRequest } from '../dispatcher'
import type {
  QueryDefinition,
  Registry,
  RequestContext,
} from '../types'

// --- fixtures ---------------------------------------------------------

function makeCtx(): RequestContext {
  return {
    userId: 'u1',
    brand: 'zivaone',
    familyId: 'f1',
    timezone: 'UTC',
    now: () => new Date(0),
  }
}

function makeRegistry(
  queries: Record<string, QueryDefinition<unknown, unknown>>
): Registry {
  return { queries, mutations: {}, events: {} }
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })
}

function wrapperWith(props: {
  registry: Registry
  engines: EngineAdapters
  brandRetentionDays?: number
}) {
  const queryClient = makeQueryClient()
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <DataAccessProvider
        registry={props.registry}
        engines={props.engines}
        context={makeCtx}
        queryClient={queryClient}
        brandRetentionDays={props.brandRetentionDays}
      >
        {children}
      </DataAccessProvider>
    )
  }
}

function rangeQuery(overrides: { asyncFetch?: boolean } = {}) {
  return defineQuery({
    engine: 'duckdb',
    input: z.object({ userId: z.string(), days: z.number() }),
    output: z.object({ n: z.number() }),
    sql: 'SELECT count() AS n FROM spo2',
    ...overrides,
  }) as unknown as QueryDefinition<unknown, unknown>
}

/** Deferred promise — lets tests hold fetchOnDemand open. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Inputs are module constants — the on-demand effect keys on input
// identity (matching the hook's existing convention), so callers pass
// stable objects.
const INPUT_180 = { userId: 'u1', days: 180 }
const INPUT_30 = { userId: 'u1', days: 30 }

afterEach(() => {
  cleanup()
})

// --- T-34 · resolveAsyncFetch -----------------------------------------

describe('T-34 · resolveAsyncFetch', () => {
  it('infers true when input.days exceeds brandRetentionDays', () => {
    expect(resolveAsyncFetch({}, { days: 180 }, 90)).toBe(true)
  })

  it('infers false when input.days is within retention', () => {
    expect(resolveAsyncFetch({}, { days: 30 }, 90)).toBe(false)
    expect(resolveAsyncFetch({}, { days: 90 }, 90)).toBe(false)
  })

  it('explicit asyncFetch: false is respected over inference', () => {
    expect(resolveAsyncFetch({ asyncFetch: false }, { days: 180 }, 90)).toBe(
      false
    )
  })

  it('explicit asyncFetch: true wins without any days input', () => {
    expect(resolveAsyncFetch({ asyncFetch: true }, { userId: 'u1' }, 90)).toBe(
      true
    )
    expect(
      resolveAsyncFetch({ asyncFetch: true }, undefined, undefined)
    ).toBe(true)
  })

  it('never infers without brandRetentionDays', () => {
    expect(resolveAsyncFetch({}, { days: 180 }, undefined)).toBe(false)
  })

  it('never infers from non-numeric or absent days', () => {
    expect(resolveAsyncFetch({}, { days: '180' }, 90)).toBe(false)
    expect(resolveAsyncFetch({}, { userId: 'u1' }, 90)).toBe(false)
    expect(resolveAsyncFetch({}, undefined, 90)).toBe(false)
  })
})

// --- T-35 · useAppQuery fetching state --------------------------------

describe('T-35 · useAppQuery fetching state', () => {
  it('serves local data during a slow fetchOnDemand, then refetches — data never disappears', async () => {
    const gate = deferred<void>()
    let counter = 0
    const execute = vi.fn(async () => {
      counter += 1
      return { n: counter }
    })
    const fetchOnDemand = vi.fn(() => gate.promise)

    const { result } = renderHook(
      () =>
        useAppQuery<typeof INPUT_180, { n: number }>('spo2.range', INPUT_180),
      {
        wrapper: wrapperWith({
          registry: makeRegistry({ 'spo2.range': rangeQuery() }),
          engines: { duckdb: { execute, fetchOnDemand } },
          brandRetentionDays: 90,
        }),
      }
    )

    // Local data serves normally while the R2 fetch is in flight.
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }))
    expect(result.current.fetching).toBe(true)
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(fetchOnDemand).toHaveBeenCalledTimes(1)
    expect(fetchOnDemand).toHaveBeenCalledWith({
      query: 'spo2.range',
      input: INPUT_180,
      userId: 'u1',
      days: 180,
    } satisfies FetchOnDemandRequest)

    // Data must stay visible for the entire fetch window.
    expect(result.current.data).toEqual({ n: 1 })

    await act(async () => {
      gate.resolve()
    })

    await waitFor(() => expect(result.current.fetching).toBe(false))
    // Completion refetched the query (fresh rows now local).
    await waitFor(() => expect(result.current.data).toEqual({ n: 2 }))
    expect(execute).toHaveBeenCalledTimes(2)
    expect(result.current.error).toBeNull()
  })

  it('fetchOnDemand failure clears fetching and surfaces error WITHOUT clearing data', async () => {
    const gate = deferred<void>()
    const execute = vi.fn(async () => ({ n: 7 }))
    const fetchOnDemand = vi.fn(() => gate.promise)

    const { result } = renderHook(
      () =>
        useAppQuery<typeof INPUT_180, { n: number }>('spo2.range', INPUT_180),
      {
        wrapper: wrapperWith({
          registry: makeRegistry({ 'spo2.range': rangeQuery() }),
          engines: { duckdb: { execute, fetchOnDemand } },
          brandRetentionDays: 90,
        }),
      }
    )

    await waitFor(() => expect(result.current.data).toEqual({ n: 7 }))
    expect(result.current.fetching).toBe(true)

    await act(async () => {
      gate.reject(new Error('r2 unreachable'))
    })

    await waitFor(() => expect(result.current.fetching).toBe(false))
    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.error?.message).toBe('r2 unreachable')
    expect(result.current.data).toEqual({ n: 7 })
    // Failure path does not refetch.
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('non-async query keeps fetching false and never calls fetchOnDemand', async () => {
    const execute = vi.fn(async () => ({ n: 1 }))
    const fetchOnDemand = vi.fn(async () => {})

    const { result } = renderHook(
      () =>
        useAppQuery<typeof INPUT_30, { n: number }>('spo2.range', INPUT_30),
      {
        wrapper: wrapperWith({
          registry: makeRegistry({ 'spo2.range': rangeQuery() }),
          engines: { duckdb: { execute, fetchOnDemand } },
          brandRetentionDays: 90,
        }),
      }
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.fetching).toBe(false)
    expect(fetchOnDemand).not.toHaveBeenCalled()
  })

  it('explicit asyncFetch: false suppresses the inferred fetch', async () => {
    const execute = vi.fn(async () => ({ n: 1 }))
    const fetchOnDemand = vi.fn(async () => {})

    const { result } = renderHook(
      () =>
        useAppQuery<typeof INPUT_180, { n: number }>('spo2.range', INPUT_180),
      {
        wrapper: wrapperWith({
          registry: makeRegistry({
            'spo2.range': rangeQuery({ asyncFetch: false }),
          }),
          engines: { duckdb: { execute, fetchOnDemand } },
          brandRetentionDays: 90,
        }),
      }
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.fetching).toBe(false)
    expect(fetchOnDemand).not.toHaveBeenCalled()
  })

  it('asyncFetch effective but engine lacks fetchOnDemand → local-only, fetching stays false', async () => {
    const execute = vi.fn(async () => ({ n: 1 }))

    const { result } = renderHook(
      () =>
        useAppQuery<typeof INPUT_180, { n: number }>('spo2.range', INPUT_180),
      {
        wrapper: wrapperWith({
          registry: makeRegistry({ 'spo2.range': rangeQuery() }),
          engines: { duckdb: { execute } },
          brandRetentionDays: 90,
        }),
      }
    )

    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }))
    expect(result.current.fetching).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('no brandRetentionDays on the provider → never inferred', async () => {
    const execute = vi.fn(async () => ({ n: 1 }))
    const fetchOnDemand = vi.fn(async () => {})

    const { result } = renderHook(
      () =>
        useAppQuery<typeof INPUT_180, { n: number }>('spo2.range', INPUT_180),
      {
        wrapper: wrapperWith({
          registry: makeRegistry({ 'spo2.range': rangeQuery() }),
          engines: { duckdb: { execute, fetchOnDemand } },
        }),
      }
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.fetching).toBe(false)
    expect(fetchOnDemand).not.toHaveBeenCalled()
  })
})
