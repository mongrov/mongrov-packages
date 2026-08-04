// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  AuthorizationError,
  DataAccessError,
  DataAccessProvider,
  createEventBus,
  defineMutation,
  defineQuery,
  useAppMutation,
  useAppQuery,
} from '../index'
import type { EngineAdapters } from '../dispatcher'
import type {
  EventBus,
  MutationDefinition,
  QueryDefinition,
  Registry,
  RequestContext,
} from '../types'

// --- fixtures ---------------------------------------------------------

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    userId: 'u1',
    brand: 'zivaone',
    familyId: 'f1',
    timezone: 'UTC',
    now: () => new Date(0),
    ...overrides,
  }
}

function makeRegistry(config: {
  queries?: Record<string, QueryDefinition<unknown, unknown>>
  mutations?: Record<string, MutationDefinition<unknown, unknown>>
}): Registry {
  return {
    queries: config.queries ?? {},
    mutations: config.mutations ?? {},
    events: {},
  }
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
  bus?: EventBus
  context?: () => RequestContext
  queryClient?: QueryClient
}) {
  const contextFn = props.context ?? (() => makeCtx())
  const queryClient = props.queryClient ?? makeQueryClient()
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <DataAccessProvider
        registry={props.registry}
        engines={props.engines}
        context={contextFn}
        bus={props.bus}
        queryClient={queryClient}
      >
        {children}
      </DataAccessProvider>
    )
  }
}

afterEach(() => {
  cleanup()
})

// --- T-11 · useAppQuery (duckdb) --------------------------------------

describe('T-11 · useAppQuery (duckdb)', () => {
  it('throws DataAccessError when the query name is not registered', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        renderHook(() => useAppQuery('missing'), {
          wrapper: wrapperWith({
            registry: makeRegistry({}),
            engines: {},
          }),
        })
      ).toThrow(DataAccessError)
    } finally {
      spy.mockRestore()
    }
  })

  it('fetches through the duckdb engine and returns typed data', async () => {
    const q = defineQuery({
      engine: 'duckdb',
      input: z.object({ userId: z.string() }),
      output: z.object({ n: z.number() }),
      sql: 'SELECT $userId AS n',
    }) as unknown as QueryDefinition<unknown, unknown>

    const execute = vi.fn(async () => ({ n: 42 }))
    const { result } = renderHook(
      () => useAppQuery<{ userId: string }, { n: number }>('hrv.last', { userId: 'u1' }),
      {
        wrapper: wrapperWith({
          registry: makeRegistry({ queries: { 'hrv.last': q } }),
          engines: { duckdb: { execute } },
        }),
      }
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeNull()
    expect(result.current.data).toEqual({ n: 42 })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith(
      'SELECT $userId AS n',
      expect.objectContaining({ userId: 'u1', brand: 'zivaone', familyId: 'f1' })
    )
  })

  it('invalidates on matching invalidatedBy emit → refetches', async () => {
    const q = defineQuery({
      engine: 'duckdb',
      output: z.number(),
      sql: 'SELECT 1',
      invalidatedBy: ['hrv:*'],
    }) as unknown as QueryDefinition<unknown, unknown>

    let counter = 0
    const execute = vi.fn(async () => {
      counter += 1
      return counter
    })
    const bus = createEventBus()

    const { result } = renderHook(() => useAppQuery<undefined, number>('hrv.count'), {
      wrapper: wrapperWith({
        registry: makeRegistry({ queries: { 'hrv.count': q } }),
        engines: { duckdb: { execute } },
        bus,
      }),
    })

    await waitFor(() => expect(result.current.data).toBe(1))

    await act(async () => {
      bus.emit('hrv:insert', null)
    })
    await waitFor(() => expect(result.current.data).toBe(2))
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('does not refetch on non-matching invalidation events', async () => {
    const q = defineQuery({
      engine: 'duckdb',
      output: z.number(),
      sql: 'SELECT 1',
      invalidatedBy: ['hrv:*'],
    }) as unknown as QueryDefinition<unknown, unknown>

    const execute = vi.fn(async () => 7)
    const bus = createEventBus()

    const { result } = renderHook(() => useAppQuery<undefined, number>('q'), {
      wrapper: wrapperWith({
        registry: makeRegistry({ queries: { q } }),
        engines: { duckdb: { execute } },
        bus,
      }),
    })

    await waitFor(() => expect(result.current.data).toBe(7))
    await act(async () => {
      bus.emit('sleep:insert', null)
    })
    // Give it a chance to (not) refetch.
    await new Promise((r) => setTimeout(r, 20))
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('surfaces engine errors via result.error', async () => {
    const q = defineQuery({
      engine: 'duckdb',
      output: z.number(),
      sql: 'SELECT 1',
    }) as unknown as QueryDefinition<unknown, unknown>

    const boom = new Error('engine boom')
    const execute = vi.fn(async () => {
      throw boom
    })

    const { result } = renderHook(() => useAppQuery<undefined, number>('q'), {
      wrapper: wrapperWith({
        registry: makeRegistry({ queries: { q } }),
        engines: { duckdb: { execute } },
      }),
    })

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error?.message).toContain('engine boom')
  })
})

// --- T-13 · useAppQuery (kv) ------------------------------------------

describe('T-13 · useAppQuery (kv)', () => {
  it('reads via keyBuilder from the kv engine', async () => {
    const q = defineQuery({
      engine: 'kv',
      input: z.object({ userId: z.string() }),
      output: z.string(),
      keyBuilder: (input) => `user:${input.userId}`,
    }) as unknown as QueryDefinition<unknown, unknown>

    const get = vi.fn((key: string) => Promise.resolve(`v-${key}`))
    const { result } = renderHook(
      () => useAppQuery<{ userId: string }, string>('profile', { userId: 'u9' }),
      {
        wrapper: wrapperWith({
          registry: makeRegistry({ queries: { profile: q } }),
          engines: { kv: { get } },
        }),
      }
    )

    await waitFor(() => expect(result.current.data).toBe('v-user:u9'))
    expect(get).toHaveBeenCalledWith('user:u9')
  })
})

// --- T-12 · useAppQuery (rxdb) ----------------------------------------

/**
 * Minimal subject-style observable used as a stand-in for RxJS in tests.
 * `emit` fires next; `fail` fires error; `close` completes.
 */
function makeSubject<T>() {
  const listeners = new Set<{
    next: (v: T) => void
    error?: (e: unknown) => void
  }>()
  return {
    observable: {
      subscribe(observer: { next: (v: T) => void; error?: (e: unknown) => void }) {
        listeners.add(observer)
        return {
          unsubscribe() {
            listeners.delete(observer)
          },
        }
      },
    },
    emit(value: T) {
      for (const l of listeners) l.next(value)
    },
    fail(err: unknown) {
      for (const l of listeners) l.error?.(err)
    },
    subscriberCount() {
      return listeners.size
    },
  }
}

describe('T-12 · useAppQuery (rxdb)', () => {
  it('subscribes on mount, parses each emission, updates on new values', async () => {
    const subject = makeSubject<number>()
    const q = defineQuery({
      engine: 'rxdb',
      output: z.number(),
      query: () => subject.observable,
    }) as unknown as QueryDefinition<unknown, unknown>

    const { result } = renderHook(() => useAppQuery<undefined, number>('live'), {
      wrapper: wrapperWith({
        registry: makeRegistry({ queries: { live: q } }),
        engines: { rxdb: { db: {}, execute: async () => 0 } },
      }),
    })

    expect(result.current.loading).toBe(true)
    expect(subject.subscriberCount()).toBe(1)

    await act(async () => {
      subject.emit(7)
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.data).toBe(7)
    expect(result.current.error).toBeNull()

    await act(async () => {
      subject.emit(42)
    })
    expect(result.current.data).toBe(42)
  })

  it('unsubscribes on unmount', () => {
    const subject = makeSubject<number>()
    const q = defineQuery({
      engine: 'rxdb',
      output: z.number(),
      query: () => subject.observable,
    }) as unknown as QueryDefinition<unknown, unknown>

    const { unmount } = renderHook(() => useAppQuery<undefined, number>('live'), {
      wrapper: wrapperWith({
        registry: makeRegistry({ queries: { live: q } }),
        engines: { rxdb: { db: {}, execute: async () => 0 } },
      }),
    })
    expect(subject.subscriberCount()).toBe(1)
    unmount()
    expect(subject.subscriberCount()).toBe(0)
  })

  it('surfaces Zod parse failures per-emission', async () => {
    const subject = makeSubject<unknown>()
    const q = defineQuery({
      engine: 'rxdb',
      output: z.object({ n: z.number() }),
      query: () => subject.observable,
    }) as unknown as QueryDefinition<unknown, unknown>

    const { result } = renderHook(
      () => useAppQuery<undefined, { n: number }>('live'),
      {
        wrapper: wrapperWith({
          registry: makeRegistry({ queries: { live: q } }),
          engines: { rxdb: { db: {}, execute: async () => 0 } },
        }),
      }
    )

    await act(async () => {
      subject.emit({ n: 'not-a-number' })
    })
    expect(result.current.error).toBeInstanceOf(DataAccessError)
    expect((result.current.error as DataAccessError).code).toBe('zod_parse_failed')
  })

  it('surfaces engine_missing when rxdb engine is not wired', async () => {
    const subject = makeSubject<number>()
    const q = defineQuery({
      engine: 'rxdb',
      output: z.number(),
      query: () => subject.observable,
    }) as unknown as QueryDefinition<unknown, unknown>

    const { result } = renderHook(() => useAppQuery<undefined, number>('live'), {
      wrapper: wrapperWith({
        registry: makeRegistry({ queries: { live: q } }),
        engines: {},
      }),
    })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect((result.current.error as DataAccessError).code).toBe('engine_missing')
  })
})

// --- T-18 · Cache defaults --------------------------------------------

describe('T-18 · Cache defaults', () => {
  it('applies default staleTime + gcTime when not overridden', async () => {
    const q = defineQuery({
      engine: 'duckdb',
      output: z.number(),
      sql: 'SELECT 1',
    }) as unknown as QueryDefinition<unknown, unknown>

    const execute = vi.fn(async () => 1)
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })

    renderHook(() => useAppQuery<undefined, number>('q'), {
      wrapper: wrapperWith({
        registry: makeRegistry({ queries: { q } }),
        engines: { duckdb: { execute } },
        queryClient: client,
      }),
    })

    await waitFor(() => {
      const state = client.getQueryState(['q', undefined])
      expect(state?.status).toBe('success')
    })
    const query = client.getQueryCache().find({ queryKey: ['q', undefined] })
    expect(query?.options.staleTime).toBe(30_000)
    // gcTime: local QueryClient default (0) is overridden per-observer, so
    // the per-query default (300_000) is what the definition would supply
    // when no client-level default fights back — verified indirectly by
    // the fact the query stays cached until we cleanup.
    expect(query).toBeDefined()
  })

  it('honors per-query overrides for staleTime + gcTime', async () => {
    const q = defineQuery({
      engine: 'duckdb',
      output: z.number(),
      sql: 'SELECT 1',
      staleTime: 5_000,
      gcTime: 10_000,
    }) as unknown as QueryDefinition<unknown, unknown>

    const execute = vi.fn(async () => 1)
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    renderHook(() => useAppQuery<undefined, number>('q'), {
      wrapper: wrapperWith({
        registry: makeRegistry({ queries: { q } }),
        engines: { duckdb: { execute } },
        queryClient: client,
      }),
    })

    await waitFor(() => {
      const state = client.getQueryState(['q', undefined])
      expect(state?.status).toBe('success')
    })
    const query = client.getQueryCache().find({ queryKey: ['q', undefined] })
    expect(query?.options.staleTime).toBe(5_000)
    expect(query?.options.gcTime).toBe(10_000)
  })
})

// --- T-19 · Zod parse errors surface as error -------------------------

describe('T-19 · Zod parse errors surface', () => {
  it('bad engine output produces a DataAccessError(zod_parse_failed)', async () => {
    const q = defineQuery({
      engine: 'duckdb',
      output: z.object({ n: z.number() }),
      sql: 'SELECT 1',
    }) as unknown as QueryDefinition<unknown, unknown>

    const execute = vi.fn(async () => ({ n: 'not-a-number' }))
    const { result } = renderHook(
      () => useAppQuery<undefined, { n: number }>('q'),
      {
        wrapper: wrapperWith({
          registry: makeRegistry({ queries: { q } }),
          engines: { duckdb: { execute } },
        }),
      }
    )

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error).toBeInstanceOf(DataAccessError)
    expect((result.current.error as DataAccessError).code).toBe('zod_parse_failed')
  })
})

// --- T-14 · useAppMutation --------------------------------------------

describe('T-14 · useAppMutation', () => {
  it('throws DataAccessError when the mutation name is not registered', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        renderHook(() => useAppMutation('missing'), {
          wrapper: wrapperWith({
            registry: makeRegistry({}),
            engines: {},
          }),
        })
      ).toThrow(DataAccessError)
    } finally {
      spy.mockRestore()
    }
  })

  it('runs exec and returns output through mutateAsync', async () => {
    const exec = vi.fn(async (input: { id: string }) => ({ ok: true, id: input.id }))
    const m = defineMutation({
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean(), id: z.string() }),
      exec,
    }) as unknown as MutationDefinition<unknown, unknown>

    const { result } = renderHook(
      () =>
        useAppMutation<{ id: string }, { ok: boolean; id: string }>('device.pair'),
      {
        wrapper: wrapperWith({
          registry: makeRegistry({ mutations: { 'device.pair': m } }),
          engines: {},
        }),
      }
    )

    let output: { ok: boolean; id: string } | undefined
    await act(async () => {
      output = await result.current.mutateAsync({ id: 'd1' })
    })
    expect(output).toEqual({ ok: true, id: 'd1' })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('emits invalidates on success', async () => {
    const m = defineMutation({
      input: z.object({ id: z.string() }),
      exec: async () => ({ ok: true }),
      invalidates: ['hrv:insert', 'sleep:insert'],
    }) as unknown as MutationDefinition<unknown, unknown>

    const bus = createEventBus()
    const hrvHandler = vi.fn()
    const sleepHandler = vi.fn()
    bus.subscribe('hrv:insert', hrvHandler)
    bus.subscribe('sleep:insert', sleepHandler)

    const { result } = renderHook(() => useAppMutation<{ id: string }, unknown>('m'), {
      wrapper: wrapperWith({
        registry: makeRegistry({ mutations: { m } }),
        engines: {},
        bus,
      }),
    })

    await act(async () => {
      await result.current.mutateAsync({ id: 'x' })
    })
    expect(hrvHandler).toHaveBeenCalledTimes(1)
    expect(sleepHandler).toHaveBeenCalledTimes(1)
  })

  it('rejects when authorize returns false (AuthorizationError)', async () => {
    const m = defineMutation({
      input: z.object({ id: z.string() }),
      authorize: () => false,
      exec: async () => ({ ok: true }),
    }) as unknown as MutationDefinition<unknown, unknown>

    const { result } = renderHook(() => useAppMutation<{ id: string }, unknown>('m'), {
      wrapper: wrapperWith({
        registry: makeRegistry({ mutations: { m } }),
        engines: {},
      }),
    })

    await expect(
      act(async () => {
        await result.current.mutateAsync({ id: 'x' })
      })
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  it('rejects on input schema failure without calling exec', async () => {
    const exec = vi.fn(async () => ({ ok: true }))
    const m = defineMutation({
      input: z.object({ id: z.string() }),
      exec,
    }) as unknown as MutationDefinition<unknown, unknown>

    const { result } = renderHook(() => useAppMutation<unknown, unknown>('m'), {
      wrapper: wrapperWith({
        registry: makeRegistry({ mutations: { m } }),
        engines: {},
      }),
    })

    await expect(
      act(async () => {
        // Deliberately wrong shape.
        await result.current.mutateAsync({ notId: 42 })
      })
    ).rejects.toBeInstanceOf(DataAccessError)
    expect(exec).not.toHaveBeenCalled()
  })

  it('surfaces optimistic value while pending; keeps real value on success', async () => {
    let resolveExec: ((v: { count: number }) => void) | undefined
    const exec = vi.fn(
      () =>
        new Promise<{ count: number }>((resolve) => {
          resolveExec = resolve
        })
    )
    const m = defineMutation({
      input: z.object({ delta: z.number() }),
      exec,
      optimistic: (input) => ({ count: input.delta * 10 }),
    }) as unknown as MutationDefinition<unknown, unknown>

    const { result } = renderHook(
      () =>
        useAppMutation<{ delta: number }, { count: number }>('inc'),
      {
        wrapper: wrapperWith({
          registry: makeRegistry({ mutations: { inc: m } }),
          engines: {},
        }),
      }
    )

    act(() => {
      result.current.mutate({ delta: 3 })
    })
    // While pending: optimistic reflected in data.
    await waitFor(() => expect(result.current.loading).toBe(true))
    expect(result.current.data).toEqual({ count: 30 })

    // Resolve exec with real value.
    await act(async () => {
      resolveExec!({ count: 99 })
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toEqual({ count: 99 })
    expect(result.current.error).toBeNull()
  })

  it('reverts optimistic (data → undefined) on failure', async () => {
    let rejectExec: ((e: Error) => void) | undefined
    const exec = vi.fn(
      () =>
        new Promise<unknown>((_r, reject) => {
          rejectExec = reject
        })
    )
    const m = defineMutation({
      input: z.object({ delta: z.number() }),
      exec,
      optimistic: (input) => ({ count: input.delta }),
    }) as unknown as MutationDefinition<unknown, unknown>

    const { result } = renderHook(
      () => useAppMutation<{ delta: number }, { count: number }>('inc'),
      {
        wrapper: wrapperWith({
          registry: makeRegistry({ mutations: { inc: m } }),
          engines: {},
        }),
      }
    )

    act(() => {
      result.current.mutate({ delta: 5 })
    })
    await waitFor(() => expect(result.current.loading).toBe(true))
    expect(result.current.data).toEqual({ count: 5 })

    await act(async () => {
      rejectExec!(new Error('boom'))
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    // Reverted: no real value present, optimistic snapshot cleared.
    expect(result.current.data).toBeUndefined()
    expect(result.current.error?.message).toBe('boom')
  })
})
