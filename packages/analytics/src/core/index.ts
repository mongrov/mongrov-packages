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

// Device event enum + payload schemas (Sprint 5 §6). Re-exported from
// @mongrov/types so @mongrov/device can emit typed events without a
// runtime dependency on the analytics engine.
export {
  decodeDeviceEventPayload,
  DEVICE_EVENT_PAYLOAD_SCHEMAS,
  DEVICE_EVENT_TYPES,
  encodeDeviceEventPayload,
  isDeviceEventType,
  SyncTrigger,
} from './device-events'
export type {
  DeviceEventPayload,
  DeviceEventType,
  SyncTriggerValue,
} from './device-events'

// Watermark cache (Sprint 5 T-07). Disabled by default — measurement-gated
// on Ziva pilot p95 latency; the instrument runs regardless.
export {
  createWatermarkCache,
  WATERMARK_CACHE_TTL_MS,
} from './watermark-cache'
export type {
  WatermarkCache,
  WatermarkCacheOptions,
  WatermarkCacheStats,
} from './watermark-cache'

// Insight dismissal (Sprint 5 §7b / T-15c).
export { dismissInsight } from './insight'
export type { DismissInsightArgs, DismissInsightDeps } from './insight'

// Effective sampling cadence (Sprint 5 T-41, principle 22). Chart data
// providers and gap detection should resolve cadence through this rather
// than reading metric_metadata directly.
export {
  createSamplingResolver,
  fallbackSampling,
  minimumWindowMinutes,
  SAMPLING_CACHE_TTL_MS,
} from './sampling'
export type {
  EffectiveSampling,
  SamplingResolver,
  SamplingResolverConfig,
} from './sampling'

// Baseline metadata (Sprint 5 §7).
export {
  baselineAggregateFor,
  BASELINE_MIN_DAYS,
  BASELINE_WINDOW_DAYS,
  getBaselineMetricIds,
} from './metric_metadata'
export type {
  BaselineDailyAggregate,
  BaselineWindowDays,
} from './metric_metadata'

// Union views (Sprint 5 §3). Registry/rule/tool SQL targets `v_{table}`,
// never `local.{table}` or `r2.default.{table}` (principle 19).
//
// LOCAL_SCHEMAS / TABLE_NAMES are public so consumers can validate their own
// SQL against the real DDL. zivaone_app's registry selected a `value` column
// from spo2 — the column is `spo2` — and nothing caught it until DuckDB did,
// on a device. A consumer-side test needs the schema to check against, and
// reaching into dist/ to get it is worse than exporting it.
export {
  dropViewDdl,
  generateViewDdl,
  LOCAL_SCHEMAS,
  quoteQualifier,
  TABLE_NAMES,
  VIEWED_TABLES,
  watermarkColumnFor,
} from './schemas'
export type { ViewedTable } from './schemas'

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
  InsightKind,
  InsightSeverity,
  KVStore,
  TenantScope,
  TokenContext,
  TokenResponse,
  TokenVendor,
  Unsubscribe,
} from './types'
