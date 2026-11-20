/**
 * @mongrov/analytics/testing — the engine's pure modules, for an app's test
 * double of `@mongrov/analytics`.
 *
 * A jest/vitest mock of the package stubs the native engine (DuckDB, the
 * attach machine, the sync manager) but still needs the real pack registry,
 * DDL helpers, platform tables and error types: a domain pack registers itself
 * and builds its DDL through them when it loads. This entry point exports
 * exactly those, under the same names as the root and `/sync` exports, so a
 * mock can re-export it instead of deep-importing `dist/` files:
 *
 *   // __mocks__/@mongrov/analytics.ts
 *   export * from '@mongrov/analytics/testing'
 *   export const createAnalytics = jest.fn(...)  // stubs for the rest
 *
 * Everything here is strings, plain objects and functions over an injected
 * engine: no native module, no React, no domain. Importing it has no side
 * effects (no pack is registered, nothing is opened). The registry is the
 * same module instance the root entry uses.
 */

// App-owned tables (principle 71).
export { appSchemaVersionKey, ensureAppSchema, validateAppSchema } from '../core/app-schema'
export type { AppMigration, AppSchema, AppTable, AppTableRetention } from '../core/app-schema'
// Bounded reads.
export {
  BOUNDED_FAILURE_LIMIT,
  boundedRelation,
  daysInterval,
  executeBounded,
  executeBoundedRead,
  FORWARD_DAYS,
  hoursInterval,
  SPARE_DAYS,
} from '../core/bounded-read'
export type { NowWindow, RelationFor } from '../core/bounded-read'
// DDL helpers.
export { addIdentityKey, qualifyDdl, quoteQualifier, toLocalDdl } from '../core/ddl'
// Errors.
export { AnalyticsError, describeError, NotImplementedError } from '../core/errors'
export type { AnalyticsErrorCode } from '../core/errors'
export { tailId } from '../core/logger'
// Metrics, as the registered packs declare them.
export { collectedOnlyColumns, exposedMetricIds, metricDefinition, registeredMetricIds, samplingLabelFor } from '../core/metrics'
export type { MetricDefinition, MetricSampling } from '../core/metrics'
export { listColumns, REMOTE_NAMESPACE } from '../core/migrations'
export type { MigrationCatalogs } from '../core/migrations'
// The pack registry, plus `resetPacks` for test isolation.
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
  resetPacks,
  viewedTables,
} from '../core/packs'
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
} from '../core/packs'
// The platform pack's tables.
export { PLATFORM_SCHEMAS, PLATFORM_TABLE_NAMES, PLATFORM_TABLES } from '../core/platform-tables'
export type { PlatformTableName } from '../core/platform-tables'
// Relations claims read.
export { cleanRelation, hasQualityRelations, qualityRelation, readRelation } from '../core/relations'
// Schemas and union views.
export { dropViewDdl, ensureSchemas, generateViewDdl, hasLocalPrimaryKey, localDdlFor, watermarkColumnFor } from '../core/schemas'
export { isSyncable, timeColumnFor } from '../core/table_metadata'
export type { TableSyncMetadata } from '../core/table_metadata'
export { userSettingKey } from '../core/user-setting-key'
// From `@mongrov/analytics/sync`: baselines, ingest drops, flush results, logging.
export { createBaselineRunner } from '../sync/baselines'
export type {
  BaselineRow,
  BaselineRunContext,
  BaselineRunner,
  BaselineRunnerConfig,
  BaselineRunResult,
  BaselineUpdate,
} from '../sync/baselines'
export { DROPPED_ROWS_EVENT, DropTally, validateRows } from '../sync/drops'
export type { DropReport, DropSummary } from '../sync/drops'
export { mergeFlushResults } from '../sync/flush-results'
export { logError } from '../sync/scheduler'
export type { SchedulerLogger } from '../sync/scheduler'
