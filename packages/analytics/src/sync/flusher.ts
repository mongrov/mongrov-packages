/**
 * Batch flusher (T-13 + T-15).
 *
 * Drains a `SensorBuffer` into a DuckDB Appender. Successful flushes are
 * durably observable (buffer.drain() removes both in-memory and overflow
 * copies), and a `SyncEmitter` fan-out surfaces `flushed` events for hooks +
 * downstream invalidation.
 *
 * Retry / concurrency (T-15):
 *   - Wrapped in a `p-queue` (concurrency=2 by default) so multi-table flushes
 *     run in parallel without hammering the CPU.
 *   - Priorities: `foreground` (0) > `manual` (1) > `scheduled` (5) >
 *     `background` (10). Lower numeric priority = runs sooner.
 *   - Backoff schedule: 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped). 5 consecutive
 *     failures per table → the flusher stops re-enqueuing and surfaces
 *     `error` state until the next explicit `flush()`.
 *   - Per-attempt timeout: 30s. Timeout aborts the attempt and counts as a
 *     failure toward the 5-failure limit.
 *
 * Data safety: attempts do *not* remove rows from the buffer until the
 * appender reports success. On failure the drained entries are re-pushed onto
 * the in-memory ring (front of queue) so subsequent retries see the same
 * batch.
 */

import { nanoid } from 'nanoid'
import PQueue from 'p-queue'

import type { HybridDuckDB } from '../core/engine'
import type { SensorBuffer } from './buffer'
import { SyncError } from './errors'
import type { BufferEntry, FlushResult } from './types'

export type FlushReason
  = | 'row-count'
    | 'age'
    | 'foreground'
    | 'background'
    | 'manual'
    | 'scheduled'

// p-queue: HIGHER priority values run first. Foreground / manual sit at the
// top; background sits at the floor.
const PRIORITY_BY_REASON: Record<FlushReason, number> = {
  foreground: 100,
  manual: 90,
  'row-count': 50,
  age: 40,
  scheduled: 10,
  background: 0,
}

/** Exponential backoff in ms, per attempt index (0-based). Capped at 60s. */
export const BACKOFF_SEQUENCE_MS: readonly number[] = [
  1_000,
  2_000,
  4_000,
  8_000,
  16_000,
  32_000,
  60_000,
]

export const MAX_CONSECUTIVE_FAILURES = 5
export const FLUSH_TIMEOUT_MS = 30_000

export type FlusherState = 'idle' | 'flushing' | 'error'

export interface FlushedEvent {
  table: string
  rowsFlushed: number
  reason: FlushReason
  /**
   * Distinct userIds observed across drained buffer entries. Empty when the
   * flush drained zero rows. Consumed by the rules engine to gate
   * `evaluateOnBatch`.
   */
  affectedUserIds: string[]
  /** Tenant observed on the drained entries; undefined for an empty flush. */
  brand?: string
  familyId?: string
}

/**
 * Emitted once after every table in a batch has flushed (Sprint 5 T-11 /
 * item (a)).
 *
 * This exists because per-table `{table}:insert` is the wrong trigger for
 * rule evaluation. A rule with `context: 'asleep'` JOINs `v_sleep_session`;
 * if it fires the instant `spo2` flushes, the matching `sleep_session` rows
 * may still be sitting in the buffer, and the rule silently evaluates
 * against an incomplete night. Waiting for the batch boundary removes the
 * race entirely rather than papering over it with a delay.
 */
export interface BatchCompleteEvent {
  batchId: string
  /** Tables that flushed at least one row in this batch. */
  affectedTables: string[]
  affectedUserIds: string[]
  brand?: string
  familyId?: string
  /** Rows written per table; only tables that wrote rows appear. */
  rowCounts: Record<string, number>
  reason: FlushReason
}

export type SyncEmitter = (event:
  | { type: 'flushed', payload: FlushedEvent }
  | { type: 'flush-failed', payload: { table: string, error: SyncError } }
  | { type: 'batch-complete', payload: BatchCompleteEvent }
) => void

/** Accumulator for one in-flight batch. */
interface BatchRecord {
  reason: FlushReason
  tables: Set<string>
  userIds: Set<string>
  rowCounts: Record<string, number>
  brand?: string
  familyId?: string
}

export interface BatchFlusherConfig {
  engine: HybridDuckDB
  buffer: SensorBuffer
  /**
   * Column order per table. Row objects are projected into positional
   * `appendRow(values[])` calls using this order. Missing tables raise
   * `flush_failed` before a single row is written.
   */
  columnOrder: Record<string, readonly string[]>
  /** Concurrent flush workers. Default 2 (spec §Retry orchestration). */
  concurrency?: number
  /** Optional test hook. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>
  /** Optional test hook. Defaults to `Date.now`. */
  now?: () => number
  /** Optional emitter for `flushed` / `flush-failed` events. */
  emit?: SyncEmitter
}

interface TableRuntimeState {
  failureCount: number
  state: FlusherState
  lastError?: SyncError
}

export class BatchFlusher {
  readonly #engine: HybridDuckDB
  readonly #buffer: SensorBuffer
  readonly #columnOrder: Record<string, readonly string[]>
  readonly #queue: PQueue
  readonly #sleep: (ms: number) => Promise<void>
  readonly #now: () => number
  readonly #emit: SyncEmitter | undefined
  readonly #tables = new Map<string, TableRuntimeState>()
  readonly #batches = new Map<string, BatchRecord>()

  constructor(config: BatchFlusherConfig) {
    this.#engine = config.engine
    this.#buffer = config.buffer
    this.#columnOrder = config.columnOrder
    this.#sleep = config.sleep ?? defaultSleep
    this.#now = config.now ?? (() => Date.now())
    this.#emit = config.emit
    this.#queue = new PQueue({ concurrency: config.concurrency ?? 2 })
  }

  // -------------------- batch lifecycle (Sprint 5 T-11) --------------------

  /**
   * Open a batch. Every `flush(table, reason, batchId)` passing this id
   * accumulates into it; `endBatch(batchId)` closes it and emits
   * `batch-complete`.
   *
   * Batches are bookkeeping, not a lock: flushes still run concurrently
   * through the p-queue, and a flush with no batchId is unaffected. The
   * batch only decides *when* downstream consumers are told the write is
   * settled.
   */
  beginBatch(reason: FlushReason = 'manual', batchId?: string): string {
    const id = batchId ?? nanoid(12)
    this.#batches.set(id, {
      reason,
      tables: new Set(),
      userIds: new Set(),
      rowCounts: {},
    })
    return id
  }

  /**
   * Close a batch and emit `batch-complete`.
   *
   * Returns the event payload, or `null` when the batch wrote nothing —
   * an empty cycle has no consumers to wake, and emitting would make rules
   * re-evaluate on no new data. Unknown ids also return `null` rather than
   * throwing, so a double-`endBatch` in a retry path is harmless.
   */
  endBatch(batchId: string): BatchCompleteEvent | null {
    const record = this.#batches.get(batchId)
    this.#batches.delete(batchId)
    if (!record || record.tables.size === 0) return null

    const payload: BatchCompleteEvent = {
      batchId,
      affectedTables: [...record.tables],
      affectedUserIds: [...record.userIds],
      brand: record.brand,
      familyId: record.familyId,
      rowCounts: record.rowCounts,
      reason: record.reason,
    }
    this.#emit?.({ type: 'batch-complete', payload })
    return payload
  }

  /** Open batch ids — diagnostics + leak detection in tests. */
  openBatchIds(): string[] {
    return [...this.#batches.keys()]
  }

  #recordInBatch(
    batchId: string | undefined,
    table: string,
    rowsFlushed: number,
    userIds: string[],
    brand: string | undefined,
    familyId: string | undefined,
  ): void {
    if (batchId === undefined) return
    const record = this.#batches.get(batchId)
    // A flush can outlive its batch if endBatch already ran (timeout, retry
    // landing late). Dropping it is correct: the batch was already reported.
    if (!record) return
    record.tables.add(table)
    record.rowCounts[table] = (record.rowCounts[table] ?? 0) + rowsFlushed
    for (const id of userIds) record.userIds.add(id)
    record.brand ??= brand
    record.familyId ??= familyId
  }

  /** Runtime state for a table. `idle` if we've never touched it. */
  stateOf(table: string): FlusherState {
    return this.#tables.get(table)?.state ?? 'idle'
  }

  lastErrorOf(table: string): SyncError | undefined {
    return this.#tables.get(table)?.lastError
  }

  /** Consecutive failures (reset on any success). */
  failureCountOf(table: string): number {
    return this.#tables.get(table)?.failureCount ?? 0
  }

  /**
   * Single flush attempt (no retry). Used directly by explicit user code and
   * indirectly by `scheduleFlush` for the retry loop.
   */
  async flush(
    table: string,
    reason: FlushReason = 'manual',
    batchId?: string,
  ): Promise<FlushResult> {
    const state = this.#ensureState(table)
    state.state = 'flushing'
    const drained = await this.#buffer.drain(table)
    if (drained.length === 0) {
      state.state = state.failureCount > 0 ? 'error' : 'idle'
      return { table, rowsFlushed: 0, ok: true }
    }

    try {
      const rowsFlushed = this.#writeToAppender(table, drained)
      state.failureCount = 0
      state.lastError = undefined
      state.state = 'idle'
      const affectedUserIds = distinctUserIds(drained)
      const brand = drained[0]?.brand
      const familyId = drained[0]?.familyId
      this.#recordInBatch(batchId, table, rowsFlushed, affectedUserIds, brand, familyId)
      this.#emit?.({
        type: 'flushed',
        payload: { table, rowsFlushed, reason, affectedUserIds, brand, familyId },
      })
      return { table, rowsFlushed, ok: true }
    }
    catch (cause) {
      // Return drained rows to the front of the ring so retries see them.
      await this.#restore(table, drained)
      const err = cause instanceof SyncError
        ? cause
        : new SyncError('flush_failed', `flush failed for ${table}`, cause)
      state.failureCount += 1
      state.lastError = err
      state.state = 'error'
      this.#emit?.({ type: 'flush-failed', payload: { table, error: err } })
      return { table, rowsFlushed: 0, ok: false, error: err }
    }
  }

  /**
   * Enqueue a flush with retry orchestration. Non-blocking — returns the
   * promise for callers that want to await final resolution.
   */
  scheduleFlush(table: string, reason: FlushReason, batchId?: string): Promise<FlushResult> {
    const priority = PRIORITY_BY_REASON[reason]
    return this.#queue.add(() => this.#runWithRetry(table, reason, batchId), { priority })
      // p-queue's typings make add() return `Promise<T | void>`; we always
      // resolve with a FlushResult so this cast is safe.
      .then(r => r as FlushResult)
  }

  /** Wait until every in-flight + queued flush settles. */
  async drainQueue(): Promise<void> {
    await this.#queue.onIdle()
  }

  /** Pause the queue — new `scheduleFlush()` calls enqueue but don't run. */
  pauseQueue(): void {
    this.#queue.pause()
  }

  /** Resume a paused queue. */
  resumeQueue(): void {
    this.#queue.start()
  }

  async #runWithRetry(
    table: string,
    reason: FlushReason,
    batchId?: string,
  ): Promise<FlushResult> {
    let lastResult: FlushResult = { table, rowsFlushed: 0, ok: false }
    for (let attempt = 0; attempt < BACKOFF_SEQUENCE_MS.length; attempt++) {
      const result = await this.#flushWithTimeout(table, reason, batchId)
      lastResult = result
      if (result.ok) return result

      const failures = this.failureCountOf(table)
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        // Terminal for this scheduled run. The `error` state persists on the
        // table until an explicit `flush()` succeeds.
        return result
      }
      await this.#sleep(BACKOFF_SEQUENCE_MS[attempt]!)
    }
    return lastResult
  }

  async #flushWithTimeout(
    table: string,
    reason: FlushReason,
    batchId?: string,
  ): Promise<FlushResult> {
    const attempt = this.flush(table, reason, batchId)
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<FlushResult>((resolve) => {
      timeoutId = setTimeout(() => {
        const err = new SyncError(
          'flush_failed',
          `flush timed out after ${FLUSH_TIMEOUT_MS}ms for ${table}`,
        )
        const state = this.#ensureState(table)
        state.failureCount += 1
        state.lastError = err
        state.state = 'error'
        this.#emit?.({ type: 'flush-failed', payload: { table, error: err } })
        resolve({ table, rowsFlushed: 0, ok: false, error: err })
      }, FLUSH_TIMEOUT_MS)
    })
    try {
      return await Promise.race([attempt, timeout])
    }
    finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }
  }

  #writeToAppender(table: string, entries: BufferEntry[]): number {
    const cols = this.#columnOrder[table]
    if (!cols) {
      throw new SyncError(
        'flush_failed',
        `no columnOrder registered for table "${table}"`,
      )
    }
    const appender = this.#engine.createAppender(table)
    let rowsWritten = 0
    try {
      for (const entry of entries) {
        for (const row of entry.rows) {
          appender.appendRow(cols.map(c => row[c] ?? null))
          rowsWritten += 1
        }
      }
      appender.flush()
      return rowsWritten
    }
    finally {
      try {
        appender.close()
      }
      catch {
        // Swallow close errors — the surfaced error should be the write.
      }
    }
  }

  async #restore(table: string, entries: BufferEntry[]): Promise<void> {
    // Cheapest recovery: re-push each entry as a fresh batch. Preserves rows
    // but reorders enqueuedAt — acceptable, since data survives.
    for (const entry of entries) {
      await this.#buffer.push({
        table,
        brand: entry.brand,
        familyId: entry.familyId,
        userId: entry.userId,
        deviceId: entry.deviceId,
        rows: entry.rows,
      })
    }
  }

  #ensureState(table: string): TableRuntimeState {
    let state = this.#tables.get(table)
    if (!state) {
      state = { failureCount: 0, state: 'idle' }
      this.#tables.set(table, state)
    }
    return state
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function distinctUserIds(entries: BufferEntry[]): string[] {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.userId) seen.add(entry.userId)
  }
  return Array.from(seen)
}
