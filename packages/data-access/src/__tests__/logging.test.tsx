// @vitest-environment jsdom

import type { QueryDefinition, Registry, RequestContext } from '../types'
import { QueryClient } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DataAccessProvider, defineQuery, useAppQuery } from '../index'

function makeCtx(): RequestContext {
  return { userId: 'u1', brand: 'zivaone', familyId: 'f1', timezone: 'UTC', now: () => new Date(0) }
}

function makeLogger() {
  return { warn: vi.fn(), error: vi.fn() }
}

function render(q: QueryDefinition<unknown, unknown>, execute: () => Promise<unknown>, logger: ReturnType<typeof makeLogger>) {
  const registry: Registry = { queries: { 'hrv.last': q }, mutations: {}, events: {} }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <DataAccessProvider
        registry={registry}
        engines={{ duckdb: { execute } }}
        context={makeCtx}
        queryClient={queryClient}
        logger={logger}
      >
        {children}
      </DataAccessProvider>
    )
  }
  return renderHook(() => useAppQuery('hrv.last', {}), { wrapper: Wrapper })
}

afterEach(() => {
  cleanup()
})

describe('DataAccessProvider logger', () => {
  it('reports a failed query at error and still surfaces it on the hook', async () => {
    const q = defineQuery({ engine: 'duckdb', output: z.number(), sql: 'SELECT 1' }) as unknown as QueryDefinition<unknown, unknown>
    const logger = makeLogger()
    const { result } = render(q, async () => {
      throw new Error('warehouse closed')
    }, logger)

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(logger.error).toHaveBeenCalledWith(
      '[@mongrov/data-access] query failed',
      expect.objectContaining({ query: 'hrv.last', error: 'Error: warehouse closed' }),
    )
  })

  it('reports an authorize denial at warn, not error', async () => {
    const q = defineQuery({
      engine: 'duckdb',
      output: z.number(),
      sql: 'SELECT 1',
      authorize: () => false,
    }) as unknown as QueryDefinition<unknown, unknown>
    const logger = makeLogger()
    const { result } = render(q, async () => 1, logger)

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(logger.warn).toHaveBeenCalledWith(
      '[@mongrov/data-access] query denied',
      expect.objectContaining({ query: 'hrv.last', code: 'authorization_denied' }),
    )
    expect(logger.error).not.toHaveBeenCalled()
  })
})
