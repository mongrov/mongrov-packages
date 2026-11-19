/**
 * @mongrov/analytics/sync — public barrel.
 *
 * Phases A–C: mapper + buffer + flusher surfaces. Pusher/fetcher/scheduler
 * ship in subsequent phases (see `.specifica/features/analytics-sync/tasks.md`).
 */

// Buffer + overflow (Phase B).
export {
  type BaselineRow,
  type BaselineRunContext,
  type BaselineRunner,
  type BaselineRunnerConfig,
  type BaselineRunResult,
  type BaselineUpdate,
  createBaselineRunner,
} from './baselines'
export { SensorBuffer, type SensorBufferConfig, type TakenBatch } from './buffer'
export { SyncProvider, type SyncProviderProps, useSyncManager } from './context'
export { DROPPED_ROWS_EVENT, DropTally, validateRows } from './drops'
export type { DropReport, DropSummary } from './drops'
export { SyncError, type SyncErrorCode } from './errors'
export type { BatchCompletePayload } from './events'

// Event bus integration (Phase H).
export {
  bindFlushEvents,
  bindPushEvents,
  type EventBus,
  type FlushInsertPayload,
  type PushEmitter,
  type SyncCompletePayload,
} from './events'
// Factory + hooks + provider (Phase I).
export { createSyncManager, type CreateSyncManagerConfig } from './factory'
export {
  type FetchParams,
  type FetchResult,
  type PrefetchPolicy,
  R2Fetcher,
  type R2FetcherConfig,
} from './fetcher'

export { mergeFlushResults } from './flush-results'
// Flusher + triggers (Phase C).
export {
  BACKOFF_SEQUENCE_MS,
  type BatchCompleteEvent,
  BatchFlusher,
  type BatchFlusherConfig,
  FLUSH_TIMEOUT_MS,
  type FlushedEvent,
  type FlusherState,
  type FlushReason,
  MAX_CONSECUTIVE_FAILURES,
  type SyncEmitter,
} from './flusher'
export { useSensorSink, useSyncProgress, useSyncState } from './hooks'
export type {
  SensorSink,
  SyncManager,
  SyncManagerState,
  SyncProgress,
} from './manager'
// Mappers (Phase A).

export { OverflowStore } from './overflow'
// SCD-2 pending closes (Phase G+).
export {
  type PushResult,
  R2Pusher,
  type R2PusherConfig,
} from './pusher'
// Scheduler (Phase G).
export {
  type BackgroundTaskPort,
  type ConstraintPort,
  type CycleResult,
  logError,
  type SchedulerConstraints,
  type SchedulerLogger,
  type SchedulerState,
  type SyncCoordinator,
  SyncScheduler,
  type SyncSchedulerConfig,
} from './scheduler'
// The sleep-correction read path, for the app's native SQL smoke
// (principle 68, zivaone_app#460): sleep-derive runs it inside the batch
// cycle, where nothing else exercises it on a device build. A caller passes
// its own `SleepRelations` so its staging views never replace sleep-derive's.
export {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_ROWS,
  FlushTriggers,
  type FlushTriggersConfig,
} from './triggers'

export type {
  BufferEntry,
  BufferSize,
  FlushResult,
  OverflowPolicy,
  SensorBatch,
} from './types'

// Watermark + pusher + fetcher (Phase D+E+F).
export {
  type WatermarkKind,
  WatermarkStore,
  type WatermarkStoreConfig,
} from './watermark'
