/**
 * React context for the analytics engine.
 *
 * `AnalyticsProvider` wires an already-constructed `AnalyticsEngine` into the
 * subtree; hooks (`useAnalytics`, `useTimeseries`, `useInsight`) resolve the
 * engine via `useAnalyticsEngine()`.
 *
 * Kept in its own module so `hooks.ts` remains pure logic (easier to unit
 * test) and the .tsx file boundary carries only JSX.
 */

import type { AnalyticsEngine } from './types'

import * as React from 'react'

const AnalyticsContext = React.createContext<AnalyticsEngine | null>(null)

export interface AnalyticsProviderProps {
  engine: AnalyticsEngine
  children: React.ReactNode
}

export function AnalyticsProvider({ engine, children }: AnalyticsProviderProps) {
  return (
    <AnalyticsContext.Provider value={engine}>
      {children}
    </AnalyticsContext.Provider>
  )
}

/**
 * Internal — hooks call this to resolve the engine. Throws a clear error when
 * used outside `AnalyticsProvider` so misconfigured apps fail loudly at mount
 * rather than surfacing an opaque null-ref later.
 */
export function useAnalyticsEngine(): AnalyticsEngine {
  const engine = React.useContext(AnalyticsContext)
  if (!engine) {
    throw new Error(
      '@mongrov/analytics: hook used outside <AnalyticsProvider>. '
      + 'Wrap your app with <AnalyticsProvider engine={createAnalytics(...)}>.',
    )
  }
  return engine
}
