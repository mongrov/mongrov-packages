// @vitest-environment jsdom

/**
 * Phase 0A contract fixes — coverage for the bridge-contract gaps found
 * by type-checking apps/zivaone queries.ts against this package:
 *
 *   DA-1 · `transform` metadata field on duckdb query configs
 *   DA-2 · MutationContext (kv / analytics / rxdb / emit) passed to exec
 *   DA-3 · `$tz` auto-binding from RequestContext.timezone
 *   DA-4 · glob entries in `invalidates` invalidate matching queries
 *   DA-5 · Registry.events accepts `undefined` (untyped) entries
 *   rename · RequestContext.userId canonical + requesterUserId alias
 */

import type { DuckdbEngine, EngineAdapters, KvEngine } from '../dispatcher'
import type {
  DuckdbQueryConfig,
  MutationContext,
  Registry,
  RequestContext,
} from '../types'
import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import * as React from 'react'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DataAccessError } from '../errors'
import {
  createEventBus,
  DataAccessProvider,
  defineMutation,
  defineQuery,
  useAppMutation,
  useAppQuery,
  useRequestContext,
} from '../index'

afterEach(() => {
  cleanup()
})

// --- fixtures ---------------------------------------------------------

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    userId: 'u1',
    brand: 'zivaone',
    familyId: 'f1',
    timezone: 'America/New_York',
    now: () => new Date(0),
    ...overrides,
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

function Providers(props: {
  registry: Registry
  engines: EngineAdapters
  children: React.ReactNode
}) {
  return (
    <DataAccessProvider
      registry={props.registry}
      engines={props.engines}
      context={makeCtx}
      queryClient={makeQueryClient()}
    >
      {props.children}
    </DataAccessProvider>
  )
}

function wrapperWith(registry: Registry, engines: EngineAdapters) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <Providers registry={registry} engines={engines}>
        {children}
      </Providers>
    )
  }
}

const emptyRegistry: Registry = { queries: {}, mutations: {}, events: {} }

// --- DA-1 · transform metadata ----------------------------------------

describe('DA-1 · duckdb `transform` field', () => {
  it('accepts and stores a transform module path on the definition', () => {
    const def = defineQuery({
      engine: 'duckdb',
      input: z.object({ userId: z.string() }),
      output: z.object({ n: z.number() }),
      sql: 'SELECT 1 AS n',
      transform: 'apps/zivaone/src/features/spo2/utils/derive-day.ts',
    })
    const config = def.config as DuckdbQueryConfig<{ userId: string }, { n: number }>
    expect(config.transform).toBe(
      'apps/zivaone/src/features/spo2/utils/derive-day.ts',
    )
  })

  it('remains optional', () => {
    const def = defineQuery({
      engine: 'duckdb',
      output: z.number(),
      sql: 'SELECT 1',
    })
    const config = def.config as DuckdbQueryConfig<unknown, number>
    expect(config.transform).toBeUndefined()
  })
})

// --- DA-2 · MutationContext -------------------------------------------

describe('DA-2 · MutationContext passed to exec', () => {
  it('wires kv.set / kv.get through the provider kv engine', async () => {
    const store = new Map<string, unknown>()
    const kv: KvEngine = {
      get: key => store.get(key),
      set: (key, value) => {
        store.set(key, value)
      },
    }

    const setLevel = defineMutation({
      input: z.object({ userId: z.string(), value: z.number() }),
      exec: async ({ userId, value }, ctx) => {
        await ctx.kv.set(`analytics:${userId}:user:spo2SafeLevel`, value)
      },
    })

    const registry: Registry = {
      queries: {},
      mutations: { 'user.setSpo2SafeLevel': setLevel },
      events: {},
    }

    const { result } = renderHook(
      () => useAppMutation<{ userId: string, value: number }, void>(
        'user.setSpo2SafeLevel',
      ),
      { wrapper: wrapperWith(registry, { kv }) },
    )

    await act(async () => {
      await result.current.mutateAsync({ userId: 'u1', value: 90 })
    })
    expect(store.get('analytics:u1:user:spo2SafeLevel')).toBe(90)
  })

  it('wires analytics.dismissInsight through the duckdb engine', async () => {
    const dismissInsight = vi.fn(async (_args: { insightId: string, userId: string }) => {})
    const duckdb: DuckdbEngine = {
      execute: async () => [],
      dismissInsight,
    }

    const dismiss = defineMutation({
      input: z.object({ insightId: z.string(), userId: z.string() }),
      exec: async ({ insightId, userId }, ctx) => {
        await ctx.analytics.dismissInsight({ insightId, userId })
      },
    })

    const registry: Registry = {
      queries: {},
      mutations: { 'insight.dismiss': dismiss },
      events: {},
    }

    const { result } = renderHook(
      () => useAppMutation<{ insightId: string, userId: string }, void>(
        'insight.dismiss',
      ),
      { wrapper: wrapperWith(registry, { duckdb }) },
    )

    await act(async () => {
      await result.current.mutateAsync({ insightId: 'i1', userId: 'u1' })
    })
    expect(dismissInsight).toHaveBeenCalledWith({ insightId: 'i1', userId: 'u1' })
  })

  it('ctx.emit publishes on the provider bus', async () => {
    let seen: MutationContext | undefined
    const poke = defineMutation({
      input: z.object({ id: z.string() }),
      exec: async (_input, ctx) => {
        seen = ctx
        ctx.emit('manual:event', { id: 'x' })
      },
    })

    const registry: Registry = {
      queries: {},
      mutations: { 'debug.poke': poke },
      events: {},
    }

    const heard: unknown[] = []

    function Screen() {
      const m = useAppMutation<{ id: string }, void>('debug.poke')
      return (
        <button data-testid="go" onClick={() => m.mutate({ id: 'x' })}>
          go
        </button>
      )
    }

    // Subscribe via a probe component using the same provider bus.
    const client = makeQueryClient()
    const bus = createEventBus()
    bus.subscribe('manual:event', payload => heard.push(payload))

    const { getByTestId } = render(
      <DataAccessProvider
        registry={registry}
        engines={{}}
        context={makeCtx}
        bus={bus}
        queryClient={client}
      >
        <Screen />
      </DataAccessProvider>,
    )

    await act(async () => {
      getByTestId('go').click()
    })

    await waitFor(() => {
      expect(heard).toEqual([{ id: 'x' }])
    })
    // MutationContext extends RequestContext — canonical identity flows in.
    expect(seen?.userId).toBe('u1')
    expect(seen?.timezone).toBe('America/New_York')
  })

  it('throws engine_missing when exec touches kv and no kv engine is wired', async () => {
    const write = defineMutation({
      input: z.object({ k: z.string() }),
      exec: async ({ k }, ctx) => {
        await ctx.kv.set(k, 1)
      },
    })

    const registry: Registry = {
      queries: {},
      mutations: { 'kv.write': write },
      events: {},
    }

    const { result } = renderHook(
      () => useAppMutation<{ k: string }, void>('kv.write'),
      { wrapper: wrapperWith(registry, {}) },
    )

    await act(async () => {
      await expect(result.current.mutateAsync({ k: 'a' })).rejects.toMatchObject(
        { code: 'engine_missing' },
      )
    })
  })

  it('throws engine_missing when analytics.dismissInsight is not provided', async () => {
    const dismiss = defineMutation({
      input: z.object({ insightId: z.string(), userId: z.string() }),
      exec: async (input, ctx) => {
        await ctx.analytics.dismissInsight(input)
      },
    })

    const registry: Registry = {
      queries: {},
      mutations: { 'insight.dismiss': dismiss },
      events: {},
    }

    // duckdb engine present but without the dismissInsight surface.
    const { result } = renderHook(
      () => useAppMutation<{ insightId: string, userId: string }, void>(
        'insight.dismiss',
      ),
      { wrapper: wrapperWith(registry, { duckdb: { execute: async () => [] } }) },
    )

    let thrown: unknown
    await act(async () => {
      thrown = await result.current
        .mutateAsync({ insightId: 'i1', userId: 'u1' })
        .then(() => null, (e: unknown) => e)
    })
    expect(thrown).toBeInstanceOf(DataAccessError)
    expect(thrown).toMatchObject({ code: 'engine_missing' })
    await waitFor(() => {
      expect(result.current.error).toMatchObject({ code: 'engine_missing' })
    })
  })
})

// --- DA-3 · $tz auto-binding ------------------------------------------

describe('DA-3 · timezone auto-binding', () => {
  it('injects tz alongside brand + familyId into duckdb params', async () => {
    const execute = vi.fn(async () => ({ n: 1 }))

    const q = defineQuery({
      engine: 'duckdb',
      input: z.object({ userId: z.string() }),
      output: z.object({ n: z.number() }),
      // References every tenant placeholder, so all four survive the
      // referenced-placeholder filter.
      sql: 'SELECT timezone($tz, now()) AS n WHERE $userId = $userId AND $brand = $brand AND $familyId = $familyId',
    })

    const registry: Registry = {
      queries: { 'tz.probe': q },
      mutations: {},
      events: {},
    }

    const { result } = renderHook(
      () => useAppQuery<{ userId: string }, { n: number }>('tz.probe', {
        userId: 'u1',
      }),
      { wrapper: wrapperWith(registry, { duckdb: { execute } }) },
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('timezone($tz, now())'),
      expect.objectContaining({
        userId: 'u1',
        brand: 'zivaone',
        familyId: 'f1',
        tz: 'America/New_York',
      }),
    )
  })
})

// --- DA-4 · wildcard invalidates --------------------------------------

describe('DA-4 · glob entries in mutation `invalidates`', () => {
  it('mutation declaring \'spo2:*\' refetches a query subscribed to \'spo2:insert\'', async () => {
    const state = { n: 0 }
    const engine: DuckdbEngine = {
      async execute() {
        return { count: state.n }
      },
    }

    const getCount = defineQuery({
      engine: 'duckdb',
      output: z.object({ count: z.number() }),
      sql: 'SELECT count() FROM spo2',
      invalidatedBy: ['spo2:insert', 'spo2:sync_complete'],
    })

    const rebind = defineMutation({
      input: z.object({ value: z.number() }),
      output: z.object({ ok: z.boolean() }),
      exec: async () => ({ ok: true }),
      invalidates: ['spo2:*'],
    })

    const registry: Registry = {
      queries: { 'spo2.count': getCount },
      mutations: { 'spo2.rebind': rebind },
      events: {},
    }

    // Spy on the bus to prove the glob string is never emitted literally.
    const bus = createEventBus()
    const literalGlobEmits: string[] = []
    bus.subscribe('spo2:*', () => literalGlobEmits.push('spo2:*'))

    function Screen() {
      const q = useAppQuery<undefined, { count: number }>('spo2.count')
      const m = useAppMutation<{ value: number }, { ok: boolean }>('spo2.rebind')
      return (
        <div>
          <span data-testid="count">
            {q.loading ? 'loading' : String(q.data?.count ?? 'nil')}
          </span>
          <button
            data-testid="rebind"
            onClick={() => {
              state.n += 1
              m.mutate({ value: 90 })
            }}
          >
            rebind
          </button>
        </div>
      )
    }

    const { getByTestId } = render(
      <DataAccessProvider
        registry={registry}
        engines={{ duckdb: engine }}
        context={makeCtx}
        bus={bus}
        queryClient={makeQueryClient()}
      >
        <Screen />
      </DataAccessProvider>,
    )

    await waitFor(() => {
      expect(getByTestId('count').textContent).toBe('0')
    })

    await act(async () => {
      getByTestId('rebind').click()
    })

    // The glob matched the query's literal 'spo2:insert' subscription and
    // invalidated its cache directly — the fresh value surfaces.
    await waitFor(() => {
      expect(getByTestId('count').textContent).toBe('1')
    })
    expect(literalGlobEmits).toEqual([])
  })

  it('non-glob entries keep emitting on the bus', async () => {
    const noop = defineMutation({
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
      exec: async () => ({ ok: true }),
      invalidates: ['insight:dismissed'],
    })

    const registry: Registry = {
      queries: {},
      mutations: { 'insight.dismiss': noop },
      events: {},
    }

    const bus = createEventBus()
    const heard: string[] = []
    bus.subscribe('insight:dismissed', () => heard.push('fired'))

    function Screen() {
      const m = useAppMutation<{ id: string }, { ok: boolean }>('insight.dismiss')
      return (
        <button data-testid="go" onClick={() => m.mutate({ id: 'i1' })}>
          go
        </button>
      )
    }

    const { getByTestId } = render(
      <DataAccessProvider
        registry={registry}
        engines={{}}
        context={makeCtx}
        bus={bus}
        queryClient={makeQueryClient()}
      >
        <Screen />
      </DataAccessProvider>,
    )

    await act(async () => {
      getByTestId('go').click()
    })

    await waitFor(() => {
      expect(heard).toEqual(['fired'])
    })
  })
})

// --- DA-5 · untyped events map ----------------------------------------

describe('DA-5 · Registry.events accepts undefined values', () => {
  it('provider mounts with an events map of undefined entries', () => {
    // Mirrors the app-side `export const events = { 'x': undefined } as const`.
    const events = {
      'threshold:violation': undefined,
      'insight:dismissed': undefined,
    } as const

    const registry: Registry = {
      queries: {},
      mutations: {},
      events,
    }

    const { getByTestId } = render(
      <Providers registry={registry} engines={{}}>
        <div data-testid="ok">ok</div>
      </Providers>,
    )
    expect(getByTestId('ok').textContent).toBe('ok')
  })
})

// --- rename · userId canonical + alias ---------------------------------

describe('RequestContext rename — userId canonical', () => {
  it('provider populates the deprecated requesterUserId alias', () => {
    const { result } = renderHook(() => useRequestContext(), {
      wrapper: wrapperWith(emptyRegistry, {}),
    })
    expect(result.current.userId).toBe('u1')
    expect(result.current.requesterUserId).toBe('u1')
  })
})
