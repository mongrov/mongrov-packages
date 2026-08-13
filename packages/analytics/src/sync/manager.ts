/**
 * T-26 — `createSyncManager` return type + shared interfaces.
 *
 * The `SyncManager` is the composition root the app holds. It owns the
 * buffer, flusher, triggers, pusher, fetcher, scheduler, and event bus
 * plumbing. `SensorSink` is the ergonomic write-side surface consumers see.
 */

import type { AnalyticsEngine, AttachContext } from '../core/types'
import type { FetchResult, R2Fetcher } from './fetcher'
import type { BatchFlusher } from './flusher'
import type { FirmwareExport, MapperContext } from './mapper/types'
import type { R2Pusher } from './pusher'
import type {
  CycleResult,
  SchedulerState,
  SyncScheduler,
} from './scheduler'
import type { FlushResult, SensorBatch } from './types'

/**
 * Ergonomic write-side API the app calls from adapters. Matches spec §SensorSink.
 */
export interface SensorSink {
  push: (batch: SensorBatch) => Promise<void>
  pushFirmware: (fw: FirmwareExport, ctx: MapperContext) => Promise<void>
  flush: () => Promise<FlushResult[]>
  pendingRowCount: (table?: string) => Promise<number>
  clear: () => Promise<void>
}

export interface SyncManagerState {
  scheduler: SchedulerState
}

export interface SyncProgress {
  pendingByTable: Record<string, number>
  lastFlushAt?: number
  lastSyncCompleteAt?: number
}

export interface SyncManager {
  readonly analytics: AnalyticsEngine
  readonly sink: SensorSink
  readonly flusher: BatchFlusher
  readonly pusher: R2Pusher
  readonly fetcher: R2Fetcher
  readonly scheduler: SyncScheduler
  state: () => SyncManagerState
  progress: () => SyncProgress
  subscribe: (fn: (state: SyncManagerState) => void) => () => void
  start: () => Promise<void>
  stop: () => Promise<void>
  triggerNow: () => Promise<CycleResult>
  prefetch: (ctx: AttachContext) => Promise<FetchResult[]>
}
