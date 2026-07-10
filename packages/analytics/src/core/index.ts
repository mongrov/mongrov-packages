/**
 * @mongrov/analytics core — public surface.
 *
 * Stubs land in T-02; concrete implementations replace them per the
 * phased tasks in `.specifica/features/analytics-core/tasks.md`.
 */

// Factory (T-02 stub → T-10 real)
export { createAnalytics } from './factory'

// Hooks (T-11/12/13)
export { useAnalytics, useInsight, useTimeseries } from './hooks'
export type {
  UseAnalyticsResult,
  UseInsightResult,
  UseTimeseriesResult,
} from './hooks'

// Provider (Phase 5)
export { AnalyticsProvider } from './context'
export type { AnalyticsProviderProps } from './context'

// Errors
export { AnalyticsError, NotImplementedError } from './errors'
export type { AnalyticsErrorCode } from './errors'

// Types
export type {
  AnalyticsAppender,
  AnalyticsConfig,
  AnalyticsEngine,
  AnalyticsLogger,
  AnalyticsState,
  AttachContext,
  EventBus,
  FamilyMembersProvider,
  Insight,
  KVStore,
  TenantScope,
  TokenContext,
  TokenResponse,
  TokenVendor,
  Unsubscribe,
} from './types'
