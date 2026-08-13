// @vitest-environment jsdom

import type { AnalyticsEngine, Insight } from '../types'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import * as React from 'react'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnalyticsProvider } from '../context'
import { useAnalytics, useInsight, useTimeseries } from '../hooks'

import { createFakeEngine } from './__fakes__/fake-engine'

afterEach(() => {
  cleanup()
})

function wrap(engine: AnalyticsEngine) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <AnalyticsProvider engine={engine}>{children}</AnalyticsProvider>
  }
}

describe('useAnalytics', () => {
  it('returns initial state + derived flags', () => {
    const fake = createFakeEngine({ state: 'ready' })
    const { result } = renderHook(() => useAnalytics(), { wrapper: wrap(fake.engine) })
    expect(result.current.state).toBe('ready')
    expect(result.current.isReady).toBe(true)
    expect(result.current.isAttached).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('re-renders when engine transitions', () => {
    const fake = createFakeEngine({ state: 'ready' })
    const { result } = renderHook(() => useAnalytics(), { wrapper: wrap(fake.engine) })

    act(() => {
      fake.setState('attached')
    })
    expect(result.current.state).toBe('attached')
    expect(result.current.isAttached).toBe(true)
  })

  it('surfaces engine.lastError when state is "error"', () => {
    const fake = createFakeEngine({ state: 'ready' })
    const err = new Error('boom')
    fake.setLastError(err)

    const { result } = renderHook(() => useAnalytics(), { wrapper: wrap(fake.engine) })
    expect(result.current.error).toBeNull()

    act(() => {
      fake.setState('error')
    })
    expect(result.current.state).toBe('error')
    expect(result.current.error).toBe(err)
    expect(result.current.isReady).toBe(false)
  })

  it('throws when used outside <AnalyticsProvider>', () => {
    // Suppress the noisy React error boundary log for this expected throw.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useAnalytics())).toThrow(/AnalyticsProvider/)
    spy.mockRestore()
  })
})

describe('useTimeseries', () => {
  it('does not fire when key is undefined', async () => {
    const fake = createFakeEngine({ state: 'attached' })
    const { result } = renderHook(
      () => useTimeseries<{ v: number }>(undefined, 'SELECT 1'),
      { wrapper: wrap(fake.engine) },
    )
    // Small microtask flush to let any stray effect land.
    await act(async () => { await Promise.resolve() })
    expect(result.current.data).toBeUndefined()
    expect(result.current.loading).toBe(false)
    expect(fake.executeCalls).toHaveLength(0)
  })

  it('waits for attached state before executing', async () => {
    const fake = createFakeEngine({ state: 'ready' })
    fake.setExecuteImpl(async () => [{ v: 1 }])

    const { result } = renderHook(
      () => useTimeseries<{ v: number }>('k1', 'SELECT 1'),
      { wrapper: wrap(fake.engine) },
    )
    await act(async () => { await Promise.resolve() })
    expect(fake.executeCalls).toHaveLength(0)

    act(() => {
      fake.setState('attached')
    })
    await waitFor(() => expect(result.current.data).toEqual([{ v: 1 }]))
    expect(fake.executeCalls).toHaveLength(1)
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('re-runs when key changes', async () => {
    const fake = createFakeEngine({ state: 'attached' })
    let call = 0
    fake.setExecuteImpl(async () => {
      call += 1
      return [{ v: call }]
    })

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useTimeseries<{ v: number }>(key, 'SELECT 1'),
      { wrapper: wrap(fake.engine), initialProps: { key: 'a' } },
    )
    await waitFor(() => expect(result.current.data).toEqual([{ v: 1 }]))

    rerender({ key: 'b' })
    await waitFor(() => expect(result.current.data).toEqual([{ v: 2 }]))
    expect(fake.executeCalls).toHaveLength(2)
  })

  it('captures engine.execute failure into `error`', async () => {
    const fake = createFakeEngine({ state: 'attached' })
    fake.setExecuteImpl(async () => {
      throw new Error('SELECT failed')
    })

    const { result } = renderHook(
      () => useTimeseries<{ v: number }>('k1', 'SELECT 1'),
      { wrapper: wrap(fake.engine) },
    )
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error))
    expect(result.current.error?.message).toBe('SELECT failed')
    expect(result.current.data).toBeUndefined()
  })

  it('refetch() re-runs the query manually', async () => {
    const fake = createFakeEngine({ state: 'attached' })
    let call = 0
    fake.setExecuteImpl(async () => {
      call += 1
      return [{ v: call }]
    })

    const { result } = renderHook(
      () => useTimeseries<{ v: number }>('k1', 'SELECT 1'),
      { wrapper: wrap(fake.engine) },
    )
    await waitFor(() => expect(result.current.data).toEqual([{ v: 1 }]))

    await act(async () => {
      await result.current.refetch()
    })
    expect(result.current.data).toEqual([{ v: 2 }])
  })

  it('discards stale results after unmount', async () => {
    const fake = createFakeEngine({ state: 'attached' })
    let resolve!: (rows: unknown[]) => void
    fake.setExecuteImpl(
      () => new Promise<unknown[]>((res) => { resolve = res }),
    )

    const { result, unmount } = renderHook(
      () => useTimeseries<{ v: number }>('k1', 'SELECT 1'),
      { wrapper: wrap(fake.engine) },
    )
    await act(async () => { await Promise.resolve() })
    // loading true, waiting on the promise.
    expect(result.current.loading).toBe(true)

    unmount()
    // Resolve after unmount — the effect's abort flag should discard.
    await act(async () => {
      resolve([{ v: 99 }])
      await Promise.resolve()
    })
    // No throw, no state update — captured via absence of error.
    expect(result.current.data).toBeUndefined()
  })
})

describe('useInsight', () => {
  it('returns undefined while engine has no catalog', async () => {
    const fake = createFakeEngine({ state: 'ready' })
    const { result } = renderHook(() => useInsight('ins-1'), { wrapper: wrap(fake.engine) })
    await act(async () => { await Promise.resolve() })
    expect(result.current.insight).toBeUndefined()
    expect(fake.executeCalls).toHaveLength(0)
  })

  it('reads insight row when engine is attached', async () => {
    const fake = createFakeEngine({ state: 'attached', catalog: 'zone_fam123' })
    const row: Insight = {
      insightId: 'ins-1',
      ts: new Date(),
      brand: 'brandA',
      familyId: 'fam123',
      userId: 'user-1',
      metric: 'hrv_ms',
      kind: 'threshold',
      severity: 'info',
      title: 'HRV below baseline',
    }
    fake.setExecuteImpl(async () => [row])

    const { result } = renderHook(() => useInsight('ins-1'), { wrapper: wrap(fake.engine) })
    await waitFor(() => expect(result.current.insight).toEqual(row))
    expect(fake.executeCalls[0].sql).toContain('zone_fam123.insight')
    expect(fake.executeCalls[0].sql).toContain('insight_id = $id')
    expect(fake.executeCalls[0].params).toEqual({ id: 'ins-1' })
  })

  it('returns undefined when no row matches', async () => {
    const fake = createFakeEngine({ state: 'attached', catalog: 'zone_fam123' })
    fake.setExecuteImpl(async () => [])

    const { result } = renderHook(() => useInsight('missing'), { wrapper: wrap(fake.engine) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.insight).toBeUndefined()
  })
})
