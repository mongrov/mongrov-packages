// @vitest-environment jsdom

/**
 * T-23 — end-to-end integration smoke test.
 *
 * Wires the full public API together the way an app would:
 *   1. Build a Registry with defineQuery + defineMutation.
 *   2. Mount DataAccessProvider with a mocked DuckDB engine, an
 *      auto-minted event bus, and a live QueryClient.
 *   3. Render a screen-like component that reads via useAppQuery and
 *      writes via useAppMutation.
 *   4. Assert the write triggers the mutation's `invalidates` pattern,
 *      which triggers the query's `invalidatedBy` subscription, which
 *      triggers a refetch that surfaces fresh data.
 *
 * This is the "rendered smoke test" from tasks.md T-23 — it exercises
 * the same code paths a real screen would, without depending on any
 * concrete storage engine.
 */

import type { DuckdbEngine, EngineAdapters } from '../dispatcher'
import type { Registry, RequestContext } from '../types'
import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import * as React from 'react'

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  DataAccessProvider,
  defineMutation,
  defineQuery,
  useAppEvent,
  useAppMutation,
  useAppQuery,
} from '../index'

afterEach(() => {
  cleanup()
})

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

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })
}

/**
 * Mock DuckDB engine that returns a mutable counter as its scalar
 * result. Screens don't see this — they see whatever their query's
 * output schema resolves to. Bumping `state.n` here simulates upstream
 * data changing between refetches.
 */
function makeCountingEngine(): DuckdbEngine & { bump: () => void, readonly n: number } {
  const state = { n: 0 }
  return {
    async execute(_sql, _params) {
      return { count: state.n }
    },
    bump() {
      state.n += 1
    },
    get n() {
      return state.n
    },
  }
}

// --- T-23 · full-stack smoke -----------------------------------------

describe('T-23 · registry → provider → hooks smoke', () => {
  it('mutation → invalidates → query refetches (real event bus + real query cache)', async () => {
    // ─── Registry ────────────────────────────────────────────────────
    const getCount = defineQuery({
      engine: 'duckdb',
      output: z.object({ count: z.number() }),
      sql: 'SELECT count() FROM ping',
      invalidatedBy: ['ping:*'],
    })

    const ping = defineMutation({
      input: z.object({ note: z.string() }),
      output: z.object({ ok: z.boolean() }),
      exec: async () => ({ ok: true }),
      invalidates: ['ping:sent'],
    })

    const registry: Registry = {
      queries: { 'stats.count': getCount },
      mutations: { 'stats.ping': ping },
      events: {},
    }

    // ─── Engine ─────────────────────────────────────────────────────
    const engine = makeCountingEngine()
    const engines: EngineAdapters = { duckdb: engine }

    // ─── Screen ─────────────────────────────────────────────────────
    // A tiny consumer that reads the query and exposes a `send()`
    // trigger backed by the mutation. Rendering to DOM lets us assert
    // on real text updates rather than hook returns.
    function Screen() {
      const q = useAppQuery<{ note: string }, { count: number }>('stats.count')
      const m = useAppMutation<{ note: string }, { ok: boolean }>('stats.ping')
      return (
        <div>
          <span data-testid="count">
            {q.loading ? 'loading' : String(q.data?.count ?? 'nil')}
          </span>
          <button
            data-testid="send"
            onClick={() => {
              engine.bump()
              m.mutate({ note: 'hello' })
            }}
          >
            send
          </button>
        </div>
      )
    }

    const client = makeQueryClient()
    const { getByTestId } = render(
      <DataAccessProvider
        registry={registry}
        engines={engines}
        context={makeCtx}
        queryClient={client}
      >
        <Screen />
      </DataAccessProvider>,
    )

    // Initial fetch resolves to n=0.
    await waitFor(() => {
      expect(getByTestId('count').textContent).toBe('0')
    })

    // Fire the mutation — engine bumps to 1, then the invalidation
    // pattern `ping:sent` fires and matches the query's `ping:*`
    // subscription, triggering a refetch.
    await act(async () => {
      getByTestId('send').click()
    })

    await waitFor(() => {
      expect(getByTestId('count').textContent).toBe('1')
    })

    // One more round-trip to confirm the invalidation loop is stable
    // across multiple mutations.
    await act(async () => {
      getByTestId('send').click()
    })

    await waitFor(() => {
      expect(getByTestId('count').textContent).toBe('2')
    })
  })

  it('useAppEvent delivers payloads emitted by a completed mutation', async () => {
    const noop = defineMutation({
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
      exec: async () => ({ ok: true }),
      invalidates: ['hrv:sample:added'],
    })

    const registry: Registry = {
      queries: {},
      mutations: { 'hrv.record': noop },
      events: {},
    }

    const heard: string[] = []

    function Listener() {
      useAppEvent<undefined>('hrv:sample:added', () => {
        heard.push('fired')
      })
      const m = useAppMutation<{ id: string }, { ok: boolean }>('hrv.record')
      return (
        <button
          data-testid="rec"
          onClick={() => m.mutate({ id: 'r1' })}
        >
          record
        </button>
      )
    }

    const { getByTestId } = render(
      <DataAccessProvider
        registry={registry}
        engines={{}}
        context={makeCtx}
        queryClient={makeQueryClient()}
      >
        <Listener />
      </DataAccessProvider>,
    )

    await act(async () => {
      getByTestId('rec').click()
    })

    await waitFor(() => {
      expect(heard).toEqual(['fired'])
    })
  })
})
