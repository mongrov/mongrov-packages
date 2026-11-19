/**
 * @mongrov/analytics core — public surface: the engine, packs, schemas,
 * migrations, quality relations, bounded reads and the React provider.
 */

// App-owned tables (principle 71): a product table is declared by the app
// and passed as `appSchema` (a pack of its own).
export { appSchemaVersionKey, ensureAppSchema, validateAppSchema } from './app-schema'

export type { AppMigration, AppSchema, AppTable, AppTableRetention } from './app-schema'

// Bounded reads: the `_between` macro forms packs build on.
export {
  BOUNDED_FAILURE_LIMIT,
  boundedRelation,
  daysInterval,
  executeBounded,
  executeBoundedRead,
  FORWARD_DAYS,
  hoursInterval,
  SPARE_DAYS,
} from './bounded-read'
export type { NowWindow, RelationFor } from './bounded-read'
// Provider
export { AnalyticsProvider } from './context'
export type { AnalyticsProviderProps } from './context'
// Helpers a pack's migrations build on.
export { addIdentityKey, qualifyDdl, quoteQualifier, toLocalDdl } from './ddl'
// Device event enum + payload schemas. Re-exported from
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
export { HybridDuckDB } from './engine'
export type { DuckDBAppender, DuckDBFactory, DuckDBInstance } from './engine'
// Errors
export { AnalyticsError, describeError, NotImplementedError } from './errors'
export type { AnalyticsErrorCode } from './errors'
// Factory
export { createAnalytics } from './factory'
// Hooks
export { useAnalytics, useInsight, useTimeseries } from './hooks'
export type {
  UseAnalyticsResult,
  UseInsightResult,
  UseTimeseriesResult,
} from './hooks'

// Insight dismissal.
export { dismissInsight } from './insight'
export type { DismissInsightArgs, DismissInsightDeps } from './insight'

export { tailId } from './logger'
// Metrics and the relations claims read, as the registered packs declare them.
export { collectedOnlyColumns, exposedMetricIds, metricDefinition, registeredMetricIds, samplingLabelFor } from './metrics'

export type { MetricDefinition, MetricSampling } from './metrics'

export { listColumns, REMOTE_NAMESPACE } from './migrations'

export type { MigrationCatalogs } from './migrations'
// Packs (principle 73): how a domain plugs into the engine.
export {
  definePack,
  getPack,
  getPacks,
  ingestAdapter,
  packExtensions,
  packTable,
  packTables,
  registerPack,
  registerPacks,
  viewedTables,
} from './packs'

export type {
  AnalyticsPack,
  BaselineDefinition,
  BaselineProvider,
  IngestAdapter,
  IngestContext,
  IngestDeps,
  IngestRows,
  NotedRows,
  PackMigration,
  PackSyncHooks,
  PackTable,
  PackTableRetention,
  PackTool,
  PackViewDdl,
  PostFlushDeps,
  PostFlushJob,
  PostFlushRunner,
  QualityViewProvider,
  RuleContextArgs,
  RulePack,
  RuleSettings,
  SyncHookDeps,
} from './packs'
// The platform pack's tables (insight, sync_watermark, tool_call_audit, user_baseline).
export { PLATFORM_SCHEMAS, PLATFORM_TABLE_NAMES, PLATFORM_TABLES } from './platform-tables'
export type { PlatformTableName } from './platform-tables'

export { cleanRelation, hasQualityRelations, qualityRelation, readRelation } from './relations'
export { ensureSchemas, hasLocalPrimaryKey, localDdlFor } from './schemas'

// Union views (Sprint 5 §3). Registry/rule/tool SQL targets `v_{table}`,
// never `local.{table}` or `r2.default.{table}` (principle 19). The viewed
// tables are the registered packs' (`viewedTables()`).
export {
  dropViewDdl,
  generateViewDdl,
  watermarkColumnFor,
} from './schemas'
// Table sync metadata (a pack table's watermark column and syncability, or
// an app table's from `appSchema`).
export { isSyncable, timeColumnFor } from './table_metadata'
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
  InsightKind,
  InsightSeverity,
  KVStore,
  QualityOptions,
  TenantScope,
  TokenContext,
  TokenResponse,
  TokenVendor,
  Unsubscribe,
} from './types'
// Watermark cache. Disabled by default — measurement-gated
// on pilot p95 latency; the instrument runs regardless.
export {
  createWatermarkCache,
  WATERMARK_CACHE_TTL_MS,
} from './watermark-cache'

export type {
  WatermarkCache,
  WatermarkCacheOptions,
  WatermarkCacheStats,
} from './watermark-cache'
