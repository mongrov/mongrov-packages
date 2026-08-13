/**
 * T-27 — React hooks over the SyncManager.
 *
 * `useSensorSink` returns the manager's memoised sink handle.
 * `useSyncState` / `useSyncProgress` bind `useSyncExternalStore` to the manager
 * subscribe fan-out. Each hook keeps a cached snapshot updated only inside the
 * subscribe callback so `getSnapshot` returns a stable reference between
 * transitions (React's snapshot-equality check requires this).
 */

import type { SensorSink, SyncManager, SyncManagerState, SyncProgress } from './manager'

import { useMemo, useSyncExternalStore } from 'react'
import { useSyncManager } from './context'

/** Subscribe to the manager's aggregate scheduler state. */
export function useSyncState(): SyncManagerState {
  const manager = useSyncManager()
  const cache = useMemo(() => makeStateCache(manager), [manager])
  return useSyncExternalStore(cache.subscribe, cache.get, cache.get)
}

/** Returns the SensorSink handle — memoised for the lifetime of the manager. */
export function useSensorSink(): SensorSink {
  return useSyncManager().sink
}

/** Progress snapshot: pending row counts + last flush / sync-complete stamps. */
export function useSyncProgress(): SyncProgress {
  const manager = useSyncManager()
  const cache = useMemo(() => makeProgressCache(manager), [manager])
  return useSyncExternalStore(cache.subscribe, cache.get, cache.get)
}

interface Cache<T> {
  subscribe: (onStoreChange: () => void) => () => void
  get: () => T
}

function makeStateCache(manager: SyncManager): Cache<SyncManagerState> {
  let snapshot = manager.state()
  return {
    subscribe: onStoreChange => manager.subscribe((next) => {
      snapshot = next
      onStoreChange()
    }),
    get: () => snapshot,
  }
}

function makeProgressCache(manager: SyncManager): Cache<SyncProgress> {
  let snapshot = manager.progress()
  return {
    subscribe: onStoreChange => manager.subscribe(() => {
      snapshot = manager.progress()
      onStoreChange()
    }),
    get: () => snapshot,
  }
}
