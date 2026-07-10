/**
 * Sync-specific types shared across buffer/flusher/pusher/fetcher/scheduler.
 *
 * Mapper types live under `sync/mapper/types.ts` — this file collects the
 * runtime infrastructure types (buffer entries, flush results, policies).
 */

// -------------------- batches --------------------

/**
 * A raw non-firmware batch of rows for a single table. Emitted by adapters
 * that already speak the warehouse row shape (e.g. custom telemetry).
 */
export interface SensorBatch {
  table: string
  brand: string
  familyId: string
  userId: string
  deviceId: string
  rows: Record<string, unknown>[]
}

/**
 * A buffered entry: the row payload plus enough context to route the flush.
 * Rows keep their per-metric context via the mapper output; SensorBatch rows
 * inherit context from the enclosing batch, and we snapshot it at push time.
 */
export interface BufferEntry {
  rows: Record<string, unknown>[]
  brand: string
  familyId: string
  userId: string
  deviceId: string
  /** Millis since epoch when the entry entered the buffer — used for age triggers. */
  enqueuedAt: number
  /** Approximate byte size — used for byte-budget accounting. */
  byteSize: number
}

// -------------------- flush + policies --------------------

export type OverflowPolicy = 'drop-oldest' | 'drop-newest' | 'block'

export interface BufferSize {
  /** Rows currently in the in-memory ring. */
  inMemory: number
  /** Rows currently persisted in overflow. */
  overflow: number
  /** Total bytes accounted for in-memory (excludes overflow, which is off-heap). */
  inMemoryBytes: number
}

export interface FlushResult {
  table: string
  rowsFlushed: number
  ok: boolean
  error?: Error
}
