/**
 * Batch flusher (T-13 + T-15).
 *
 * Takes a `SensorBuffer`'s rows into a DuckDB Appender. Durable (overflow)
 * rows are removed only after the write commits (`buffer.take` + `commit`),
 * and a `SyncEmitter` fan-out surfaces `flushed` events for hooks +
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
 * Data safety: attempts do *not* remove durable rows until the write reports
 * success. This comment said so for a long time while `flush` called
 * `buffer.drain()` first, which deleted overflow chunks before writing; a
 * process killed mid-write lost them (zivaone_app#54). On failure the batch
 * is released: durable rows stay on disk, in-memory rows return to the ring,
 * and the next attempt sees the same rows.
 */

import type { HybridDuckDB } from '../core/engine'
import type { TableName } from '../core/schemas'
import type { SensorBuffer } from './buffer'

import type { BufferEntry, FlushResult } from './types'
import { nanoid } from 'nanoid'
import PQueue from 'p-queue'
import { LOCAL_SCHEMAS } from '../core/schemas'
import { SyncError } from './errors'

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
  'foreground': 100,
  'manual': 90,
  'row-count': 50,
  'age': 40,
  'scheduled': 10,
  'background': 0,
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
  /**
   * Rows this flush could not write and will not retry (zivaone_app#226).
   * Absent or 0 on a clean flush. Non-zero means data was dropped on
   * purpose — the count is here so that loss is visible without reading
   * DuckDB error text out of a log line.
   */
  rowsRejected?: number
  /** One example rejection, to name the offending value. */
  rejectedSample?: string
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
  | { type: 'batch-complete', payload: BatchCompleteEvent },
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

/**
 * Whether the local table carries a PRIMARY KEY — its own (`sleep_session`,
 * `device_config`) or one injected from IDENTITY_COLUMNS. Keyed tables must
 * go through the staging + ON CONFLICT path; see `#write`.
 */
function isKeyed(table: string): boolean {
  return LOCAL_SCHEMAS[table as TableName]?.includes('PRIMARY KEY') ?? false
}

/**
 * A short, loggable description of why rows were rejected. DuckDB puts the
 * offending value in the message ("Could not cast value 6537.800293 to
 * DECIMAL(4,1)"), which is the one detail worth keeping.
 */
function describeRejection(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 200 ? `${message.slice(0, 200)}…` : message
}

/** A row with the buffer entry it came from, so tenant fields survive a split. */
interface FlatRow {
  row: Record<string, unknown>
  parent: BufferEntry
}

function flattenEntries(entries: BufferEntry[]): FlatRow[] {
  return entries.flatMap(parent => parent.rows.map(row => ({ row, parent })))
}

/**
 * Regroup flat rows into buffer entries, preserving each row's tenant
 * context. Order within an entry is preserved; entries with no surviving
 * rows disappear.
 */
function rebuildEntries(rows: FlatRow[]): BufferEntry[] {
  const byParent = new Map<BufferEntry, Record<string, unknown>[]>()
  for (const { row, parent } of rows) {
    const list = byParent.get(parent) ?? []
    list.push(row)
    byParent.set(parent, list)
  }
  return Array.from(byParent, ([parent, grouped]) => ({ ...parent, rows: grouped }))
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
  /** Probe tables whose NOT NULL columns already mirror their target. */
  readonly #probesAligned = new Set<string>()
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
    if (!record || record.tables.size === 0)
      return null

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
    if (batchId === undefined)
      return
    const record = this.#batches.get(batchId)
    // A flush can outlive its batch if endBatch already ran (timeout, retry
    // landing late). Dropping it is correct: the batch was already reported.
    if (!record)
      return
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
    const taken = await this.#buffer.take(table)
    const drained = taken.entries
    if (drained.length === 0) {
      await taken.release()
      state.state = state.failureCount > 0 ? 'error' : 'idle'
      return { table, rowsFlushed: 0, ok: true }
    }

    let rowsRejected = 0
    let rejectedSample: string | undefined
    try {
      let rowsFlushed: number
      try {
        rowsFlushed = await this.#write(table, drained)
      }
      catch (writeError) {
        // One unwritable value must not cost the table forever
        // (zivaone_app#226). Find the rows that cannot be written, write the
        // rest, and let the batch commit so the poison rows leave the buffer.
        //
        // Only once the table has exhausted its retry budget. Dropping rows
        // is irreversible, so it must never be the answer to a passing
        // problem — a timeout, a busy connection, a half-open engine. Those
        // clear within the existing backoff; a value the column cannot hold
        // fails identically every time and is still here on the last attempt.
        // Checked BEFORE this failure is counted, so the isolation runs on
        // attempt MAX_CONSECUTIVE_FAILURES rather than one past it.
        if (state.failureCount + 1 < MAX_CONSECUTIVE_FAILURES)
          throw writeError
        const flat = flattenEntries(drained)
        const { good, bad } = await this.#classifyRows(table, flat)
        if (bad.length === 0)
          throw writeError
        rowsRejected = bad.length
        rejectedSample = describeRejection(writeError)
        rowsFlushed = good.length > 0 ? await this.#write(table, rebuildEntries(good)) : 0
      }
      // Only now is it safe to forget the durable copies. If this commit
      // itself fails, the rows stay on disk and are written again next time,
      // which the idempotent staging write turns into a no-op.
      await taken.commit()
      state.failureCount = 0
      state.lastError = undefined
      state.state = 'idle'
      const affectedUserIds = distinctUserIds(drained)
      const brand = drained[0]?.brand
      const familyId = drained[0]?.familyId
      this.#recordInBatch(batchId, table, rowsFlushed, affectedUserIds, brand, familyId)
      this.#emit?.({
        type: 'flushed',
        payload: {
          table,
          rowsFlushed,
          reason,
          affectedUserIds,
          brand,
          familyId,
          ...(rowsRejected > 0 ? { rowsRejected, rejectedSample } : {}),
        },
      })
      return {
        table,
        rowsFlushed,
        ok: true,
        ...(rowsRejected > 0 ? { rowsRejected, rejectedSample } : {}),
      }
    }
    catch (cause) {
      await taken.release()
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
      if (result.ok)
        return result

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
      if (timeoutId !== undefined)
        clearTimeout(timeoutId)
    }
  }

  /**
   * Write a drained batch, idempotently where the table declares an identity
   * tuple (principle 66).
   *
   * Appending straight into a keyed table is not an option: the DuckDB
   * Appender enforces primary keys, has no `ON CONFLICT`, and throws
   * `Failed to append: Duplicate key ...`. That error is not
   * transaction-exempt, so it poisons the shared connection — and `#restore`
   * puts the batch back at the front of the ring, so the next attempt fails
   * identically until the failure limit trips. A re-sync would take the
   * warehouse down rather than deduplicate.
   *
   * So: append into an unconstrained staging table (full appender speed),
   * then one set-based `INSERT ... ON CONFLICT DO NOTHING` into the target.
   * Measured at 10k rows: 7ms direct append, 14ms via staging, 9ms when the
   * whole batch is duplicates. The cost is one extra pass, not the ~19x that
   * row-wise `INSERT ... VALUES` would have cost.
   *
   * The test is "does the table declare ANY primary key", not "is it in
   * IDENTITY_COLUMNS". `sleep_session` and `device_config` spell their own
   * key in the base DDL and are deliberately absent from IDENTITY_COLUMNS,
   * so an IDENTITY_COLUMNS test sent both down the Appender path: a re-synced
   * night threw `Duplicate key` and jammed every later row behind it (found
   * by the UX team's app-side patch; `flusher-self-keyed.test.ts`). Only
   * keyless tables (`tool_call_audit` is append-only by design) take the
   * direct path.
   *
   * Returns rows APPENDED, not rows inserted. The count feeds buffer
   * accounting and the batch record, both of which are about what was
   * drained; a dedupe is not a failure to flush.
   */
  async #write(table: string, entries: BufferEntry[]): Promise<number> {
    const cols = this.#columnOrder[table]
    if (!cols) {
      throw new SyncError(
        'flush_failed',
        `no columnOrder registered for table "${table}"`,
      )
    }

    if (!isKeyed(table))
      return this.#appendInto(table, table, entries)

    const staging = `${table}__stg`
    // Unconstrained mirror of the target: `WHERE false` copies the column
    // list and types without the primary key, which is what makes the
    // appender usable here.
    await this.#engine.execute(
      `CREATE TABLE IF NOT EXISTS ${staging} AS SELECT * FROM ${table} WHERE false;`,
    )
    // A previous crash between append and insert would leave rows behind;
    // they would be re-inserted here as duplicates of a batch already
    // flushed. Cheap to clear, expensive to reason about if we do not.
    await this.#engine.execute(`DELETE FROM ${staging};`)

    const rowsAppended = this.#appendInto(staging, table, entries)
    const columnList = cols.join(', ')
    await this.#engine.execute(
      `INSERT INTO ${table} (${columnList}) `
      + `SELECT ${columnList} FROM ${staging} ON CONFLICT DO NOTHING;`,
    )
    await this.#engine.execute(`DELETE FROM ${staging};`)
    return rowsAppended
  }

  /** Mirror the target's NOT NULL columns onto the probe, once per probe. */
  async #copyNotNull(table: string, probe: string): Promise<void> {
    if (this.#probesAligned.has(probe))
      return
    const required = await this.#engine.execute<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns `
      + `WHERE table_name = '${table}' AND is_nullable = 'NO'`,
    )
    for (const { column_name } of required) {
      try {
        await this.#engine.execute(
          `ALTER TABLE ${probe} ALTER COLUMN ${column_name} SET NOT NULL;`,
        )
      }
      catch {
        // Already constrained, or the engine will not take it. The probe is
        // then merely more permissive than the target, which is the
        // pre-existing behaviour — never less permissive, which would
        // discard writable rows.
      }
    }
    this.#probesAligned.add(probe)
  }

  /**
   * Split a failed batch into the rows that can be written and the rows that
   * cannot (zivaone_app#226).
   *
   * One value the target column cannot represent — `6537.8` into
   * `temp_c DECIMAL(4,1)` — failed the whole table's write. The batch was
   * then released back to the buffer by design (T-45 keeps durable rows until
   * a write commits), so the same row was retried on every later flush and
   * that metric could never write again. Its delta cursor is the newest
   * stored row, so it never advanced either: every sync re-pulled the whole
   * history and failed on the same row. The vital reads "Never measured"
   * while the ring streams hundreds of readings a day.
   *
   * Rows are classified against a scratch copy of the target rather than by
   * retrying the target directly: a batch that partially appended before
   * throwing, then retried in halves, could write a row twice. Classifying
   * against `{table}__probe` keeps the target untouched until there is a
   * validated set, which is then written exactly once by the caller through
   * the normal path.
   *
   * The probe deliberately does NOT copy the PRIMARY KEY. Every metric table
   * has one — `withIdentityKey` splices the `IDENTITY_COLUMNS` tuple into the
   * local DDL, so it is absent from the `SCHEMAS` string and present on the
   * created table — and keyed tables reach the target through `ON CONFLICT DO
   * NOTHING`. A duplicate is therefore not a rejection, and a probe that
   * enforced the key would discard rows the target accepts. NOT NULL is
   * copied for the opposite reason: the target does enforce it.
   *
   * If the engine itself is down, creating or clearing the probe throws and
   * the original failure is rethrown — a broken connection must not be read
   * as "every row is bad" and silently discard a batch.
   */
  async #classifyRows(
    table: string,
    rows: FlatRow[],
  ): Promise<{ good: FlatRow[], bad: FlatRow[] }> {
    const probe = `${table}__probe`
    await this.#engine.execute(
      `CREATE TABLE IF NOT EXISTS ${probe} AS SELECT * FROM ${table} WHERE false;`,
    )
    // `CREATE TABLE AS SELECT` copies column types but NOT constraints, so
    // the probe would accept a NULL the target rejects — classification would
    // report every row writable, the real write would fail anyway, and the
    // table would be stuck exactly as before. Copy NOT NULL across. The
    // PRIMARY KEY is deliberately NOT copied: keyed tables reach the target
    // through `ON CONFLICT DO NOTHING`, so a duplicate is not a rejection and
    // a probe that enforced the key would discard rows the target accepts.
    await this.#copyNotNull(table, probe)

    const accepts = async (subset: FlatRow[]): Promise<boolean> => {
      await this.#engine.execute(`DELETE FROM ${probe};`)
      try {
        this.#appendInto(probe, table, rebuildEntries(subset))
        return true
      }
      catch {
        return false
      }
    }

    const walk = async (subset: FlatRow[]): Promise<{ good: FlatRow[], bad: FlatRow[] }> => {
      if (subset.length === 0)
        return { good: [], bad: [] }
      if (await accepts(subset))
        return { good: subset, bad: [] }
      if (subset.length === 1)
        return { good: [], bad: subset }
      const mid = Math.floor(subset.length / 2)
      const left = await walk(subset.slice(0, mid))
      const right = await walk(subset.slice(mid))
      return { good: [...left.good, ...right.good], bad: [...left.bad, ...right.bad] }
    }

    try {
      return await walk(rows)
    }
    finally {
      // Best-effort: a leftover probe row is harmless (the next classify
      // clears it first) and must not mask the write error being handled.
      try {
        await this.#engine.execute(`DELETE FROM ${probe};`)
      }
      catch {}
    }
  }

  /** Append `entries` into `target`, using `columnOrder` of `sourceTable`. */
  #appendInto(target: string, sourceTable: string, entries: BufferEntry[]): number {
    const cols = this.#columnOrder[sourceTable]!
    const appender = this.#engine.createAppender(target)
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
    if (entry.userId)
      seen.add(entry.userId)
  }
  return Array.from(seen)
}
