/**
 * React context for the SyncManager.
 *
 * `SyncProvider` wires an already-constructed `SyncManager` into the subtree;
 * hooks (`useSyncState`, `useSensorSink`, `useSyncProgress`) resolve it via
 * `useSyncManager()`.
 */

import type { SyncManager } from './manager'

import * as React from 'react'

const SyncContext = React.createContext<SyncManager | null>(null)

export interface SyncProviderProps {
  manager: SyncManager
  children: React.ReactNode
}

export function SyncProvider({ manager, children }: SyncProviderProps) {
  return (
    <SyncContext.Provider value={manager}>
      {children}
    </SyncContext.Provider>
  )
}

/** Resolves the SyncManager. Throws when used outside `<SyncProvider>`. */
export function useSyncManager(): SyncManager {
  const manager = React.useContext(SyncContext)
  if (!manager) {
    throw new Error(
      '@mongrov/analytics/sync: hook used outside <SyncProvider>. '
      + 'Wrap your app with <SyncProvider manager={createSyncManager(...)}>.',
    )
  }
  return manager
}
