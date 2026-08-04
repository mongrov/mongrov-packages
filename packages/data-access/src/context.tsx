/**
 * DataAccessProvider (T-16) + internal context.
 *
 * The provider is the single injection point for the registry, engine
 * adapters, RequestContext factory, event bus, and TanStack QueryClient.
 * If no bus / queryClient is supplied, one is created lazily and shared
 * across the entire tree.
 *
 * See data-access/spec.md §Registry pattern.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import * as React from 'react'

import { DataAccessError } from './errors'
import type { EngineAdapters } from './dispatcher'
import { createEventBus } from './invalidation'
import type {
  EventBus,
  Registry,
  RequestContext,
} from './types'

/**
 * Concrete provider props. Diverges from DataAccessProviderProps in
 * ./types (which stays engine-agnostic to avoid a circular import) by
 * accepting a strongly typed EngineAdapters bundle.
 */
export interface DataAccessProviderConfig {
  registry: Registry
  engines: EngineAdapters
  context: () => RequestContext
  /**
   * Optional override — when omitted the provider mints its own bus.
   * Sharing a bus across nested providers is a v0.2.0 concern.
   */
  bus?: EventBus
  /**
   * Optional override — when omitted the provider mints its own
   * QueryClient with default options. Supply your own to share a
   * client across nested trees or to configure retry/staleTime.
   */
  queryClient?: QueryClient
  /**
   * T-34 — brand data-retention horizon in days (principle 57). Queries
   * whose `input.days` exceeds this are implicitly asyncFetch. Omitted →
   * asyncFetch is never inferred (explicit per-query flags still apply).
   */
  brandRetentionDays?: number
  children?: ReactNode
}

/**
 * Runtime shape exposed via context. Kept internal so app code goes
 * through hooks (useRequestContext / useAppEvent / …) — no direct
 * consumers of the context value.
 */
export interface DataAccessRuntime {
  registry: Registry
  engines: EngineAdapters
  bus: EventBus
  queryClient: QueryClient
  getContext: () => RequestContext
  /** T-34 — retention horizon for implicit asyncFetch inference. */
  brandRetentionDays?: number
}

const DataAccessContext = React.createContext<DataAccessRuntime | null>(null)

DataAccessContext.displayName = 'DataAccessContext'

export function DataAccessProvider(
  props: DataAccessProviderConfig
): React.ReactElement {
  const {
    registry,
    engines,
    context,
    bus: suppliedBus,
    queryClient: suppliedClient,
    brandRetentionDays,
    children,
  } = props

  // Bus / client are created once per provider mount. Deliberately not
  // memoized on the supplied identity — swapping either mid-lifetime is
  // unsupported.
  const busRef = React.useRef<EventBus | null>(null)
  if (busRef.current === null) {
    busRef.current = suppliedBus ?? createEventBus()
  }

  const clientRef = React.useRef<QueryClient | null>(null)
  if (clientRef.current === null) {
    clientRef.current = suppliedClient ?? new QueryClient()
  }

  const runtime = React.useMemo<DataAccessRuntime>(
    () => ({
      registry,
      engines,
      bus: busRef.current as EventBus,
      queryClient: clientRef.current as QueryClient,
      getContext: () => withUserAliases(context()),
      brandRetentionDays,
    }),
    [registry, engines, context, brandRetentionDays]
  )

  return (
    <DataAccessContext.Provider value={runtime}>
      <QueryClientProvider client={runtime.queryClient}>
        {children}
      </QueryClientProvider>
    </DataAccessContext.Provider>
  )
}

/**
 * `userId` is canonical (renamed from `requesterUserId`; spec §Tenant
 * auto-binding). The provider populates both names so consumers on
 * either side of the rename keep working — including legacy callers
 * that (untyped) still supply only `requesterUserId`.
 */
function withUserAliases(ctx: RequestContext): RequestContext {
  const canonical = ctx.userId ?? ctx.requesterUserId ?? ''
  if (ctx.userId === canonical && ctx.requesterUserId === canonical) {
    return ctx
  }
  return { ...ctx, userId: canonical, requesterUserId: canonical }
}

/**
 * Internal — used by every hook to reach the runtime. Throws a typed
 * error when a hook is used outside a DataAccessProvider.
 */
export function useDataAccessRuntime(): DataAccessRuntime {
  const runtime = React.useContext(DataAccessContext)
  if (runtime === null) {
    throw new DataAccessError(
      'engine_missing',
      'data-access hook called outside <DataAccessProvider>'
    )
  }
  return runtime
}
