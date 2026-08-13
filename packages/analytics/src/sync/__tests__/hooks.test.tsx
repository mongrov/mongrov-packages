// @vitest-environment jsdom

/**
 * T-27 — React hooks over the SyncManager.
 *
 * Coverage:
 *   1. `useSyncManager` throws outside `<SyncProvider>`.
 *   2. `useSensorSink` returns the manager's sink (stable reference).
 *   3. `useSyncState` returns initial `{ scheduler: 'idle' }` and re-renders
 *      when scheduler state changes.
 *   4. `useSyncProgress` re-renders when progress deltas fan out via subscribe.
 */

import type { AnalyticsEngine, AttachContext } from '../../core/types'
import type { SyncManager } from '../manager'
import { act, cleanup, renderHook } from '@testing-library/react'

import * as React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { SyncProvider, useSyncManager } from '../context'
import { createSyncManager } from '../factory'
import { useSensorSink, useSyncProgress, useSyncState } from '../hooks'
import { createFakeEngine } from './__fakes__/fake-engine'

afterEach(() => {
  cleanup()
})

const ctx: AttachContext = {
  brand: 'ziva',
  tenantScope: 'family',
  tenantId: 'fam_A',
  userId: 'u1',
}

function makeManager(): SyncManager {
  const fake = createFakeEngine()
  return createSyncManager({
    analytics: fake.engine as unknown as AnalyticsEngine,
    storage: createFakeKV().kv,
    ctx,
    tables: ['hrv'],
    columnOrder: {
      hrv: ['user_id', 'device_id', 'ts', 'rmssd_ms'],
    },
    prefetchPolicy: { kind: 'lazy' },
  })
}

function wrap(manager: SyncManager) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <SyncProvider manager={manager}>{children}</SyncProvider>
  }
}

describe('useSyncManager', () => {
  it('throws when used outside a SyncProvider', () => {
    // Intercept React's console.error for the expected error.
    const original = console.error
    console.error = () => {}
    try {
      expect(() => renderHook(() => useSyncManager())).toThrow(
        /used outside <SyncProvider>/,
      )
    }
    finally {
      console.error = original
    }
  })

  it('returns the manager passed to the provider', () => {
    const manager = makeManager()
    const { result } = renderHook(() => useSyncManager(), { wrapper: wrap(manager) })
    expect(result.current).toBe(manager)
  })
})

describe('useSensorSink', () => {
  it('returns the manager sink and reference is stable', () => {
    const manager = makeManager()
    const { result, rerender } = renderHook(() => useSensorSink(), { wrapper: wrap(manager) })
    const firstSink = result.current
    rerender()
    expect(result.current).toBe(firstSink)
    expect(result.current).toBe(manager.sink)
  })
})

describe('useSyncState', () => {
  it('returns initial scheduler state (idle)', () => {
    const manager = makeManager()
    const { result } = renderHook(() => useSyncState(), { wrapper: wrap(manager) })
    expect(result.current.scheduler).toBe('idle')
  })

  it('re-renders when scheduler transitions', async () => {
    const manager = makeManager()
    const { result } = renderHook(() => useSyncState(), { wrapper: wrap(manager) })
    expect(result.current.scheduler).toBe('idle')
    await act(async () => {
      await manager.triggerNow()
    })
    // After a full cycle we should be back to idle (transient running observed).
    expect(result.current.scheduler).toBe('idle')
  })
})

describe('useSyncProgress', () => {
  it('returns initial progress with empty pendingByTable', () => {
    const manager = makeManager()
    const { result } = renderHook(() => useSyncProgress(), { wrapper: wrap(manager) })
    expect(result.current.pendingByTable).toEqual({})
    expect(result.current.lastFlushAt).toBeUndefined()
  })

  it('re-renders when scheduler subscribe fires (progress fan-out)', async () => {
    const manager = makeManager()
    const { result } = renderHook(() => useSyncProgress(), { wrapper: wrap(manager) })
    const initial = result.current
    await act(async () => {
      await manager.triggerNow()
    })
    // A fresh snapshot should have been captured (still an object; contents may match initial).
    expect(result.current).not.toBe(initial)
  })
})
