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

// Table sync metadata registry (v0.2.0 — public surface for consumers
// who need to know a table's sync watermark column or syncability flag,
// e.g. when composing custom pushAll/fetch loops).
export { isSyncable, TABLE_METADATA, timeColumnFor } from './table_metadata'
export type { TableSyncMetadata } from './table_metadata'

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
