/**
 * @mongrov/analytics/sync — public barrel.
 *
 * Phases A–C: mapper + buffer + flusher surfaces. Pusher/fetcher/scheduler
 * ship in subsequent phases (see `.specifica/features/analytics-sync/tasks.md`).
 */

// Buffer + overflow (Phase B).
export { SensorBuffer, type SensorBufferConfig } from './buffer'
export { OverflowStore } from './overflow'
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
export {
  type PushResult,
  R2Pusher,
  type R2PusherConfig,
} from './pusher'
export {
  type FetchParams,
  type FetchResult,
  type PrefetchPolicy,
  R2Fetcher,
  type R2FetcherConfig,
} from './fetcher'

// Flusher + triggers (Phase C).
export {
  BACKOFF_SEQUENCE_MS,
  BatchFlusher,
  type BatchFlusherConfig,
  FLUSH_TIMEOUT_MS,
  type FlushReason,
  type FlushedEvent,
  MAX_CONSECUTIVE_FAILURES,
  type FlusherState,
  type SyncEmitter,
} from './flusher'
export { SyncError, type SyncErrorCode } from './errors'
export {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_ROWS,
  FlushTriggers,
  type FlushTriggersConfig,
} from './triggers'

// Factory + hooks + provider (Phase I).
export { createSyncManager, type CreateSyncManagerConfig } from './factory'
export type {
  SensorSink,
  SyncManager,
  SyncManagerState,
  SyncProgress,
} from './manager'
export { SyncProvider, type SyncProviderProps, useSyncManager } from './context'
export { useSensorSink, useSyncProgress, useSyncState } from './hooks'

// Event bus integration (Phase H).
export {
  bindFlushEvents,
  bindPushEvents,
  type EventBus,
  type FlushInsertPayload,
  type PushEmitter,
  type SyncCompletePayload,
} from './events'

// Scheduler (Phase G).
export {
  type BackgroundTaskPort,
  type ConstraintPort,
  type CycleResult,
  type SchedulerConstraints,
  type SchedulerLogger,
  type SchedulerState,
  type SyncCoordinator,
  SyncScheduler,
  type SyncSchedulerConfig,
} from './scheduler'

// Mappers (Phase A).
export { mapActivity, type MapActivityResult } from './mapper/activity'
export { BATTERY_EVENT, mapBattery } from './mapper/battery'
export {
  type FirmwareMappedBatch,
  mapFirmwareExport,
  type MapFirmwareOptions,
} from './mapper/firmware'
export { mapHeartRate } from './mapper/heart-rate'
export { mapHrv } from './mapper/hrv'
export {
  type MapRingConfigResult,
  mapRingConfig,
  type RingConfigClose,
} from './mapper/ring-config'
export {
  type ReconstructSleepResult,
  reconstructSleepSessions,
} from './mapper/sleep'
export { mapSpo2 } from './mapper/spo2'
export { mapTemperature } from './mapper/temperature'
export { computeNightOf, parseTimestamp } from './mapper/time'

export type {
  ActivityBucketRow,
  ActivityRow,
  DeviceConfigRow,
  DeviceBatteryRow,
  DeviceEventRow,
  FirmwareActivityRow,
  FirmwareBatteryRow,
  FirmwareExport,
  FirmwareHRRow,
  FirmwareHRVRow,
  FirmwareMonitoringWindow,
  FirmwareRingConfig,
  FirmwareSleepRow,
  FirmwareSpO2Row,
  FirmwareTempRow,
  HeartRateRow,
  HrvRow,
  MappedBatch,
  MapperContext,
  RingConfigTranslator,
  SleepRawRow,
  SleepSessionRow,
  SleepStageRow,
  Spo2Row,
  TemperatureRow,
} from './mapper/types'

// SCD-2 pending closes (Phase G+).
export { PendingClosesStore } from './pending_closes'
