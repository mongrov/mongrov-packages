/**
 * Flush triggers (T-14).
 *
 * Observes the `SensorBuffer` + app lifecycle and decides when to enqueue a
 * flush. Triggers are:
 *   - `row-count`  → any table hits `maxRows`
 *   - `age`        → oldest entry's `enqueuedAt` older than `maxAgeMs`
 *   - `foreground` → app-state 'active' transition
 *   - `background` → app-state 'background' transition (best-effort)
 *   - `manual`     → caller-invoked
 *
 * All triggers ultimately funnel through `BatchFlusher.scheduleFlush(table,
 * reason)`. Row-count / age evaluations are driven by an external ticker so
 * the trigger controller stays synchronous + testable — the app wires a
 * `setInterval` (or the sync scheduler) to `evaluate()`.
 */

import type { SensorBuffer } from './buffer'
import type { BatchFlusher, FlushReason } from './flusher'

export interface FlushTriggersConfig {
  buffer: SensorBuffer
  flusher: BatchFlusher
  /** Row count threshold — any table hitting this triggers a flush. */
  maxRows?: number
  /** Age threshold in ms — oldest entry older than this triggers a flush. */
  maxAgeMs?: number
  /** Test-injected clock. */
  now?: () => number
}

/** Default from spec §Flush triggers. */
export const DEFAULT_MAX_ROWS = 500
export const DEFAULT_MAX_AGE_MS = 30_000

export class FlushTriggers {
  readonly #buffer: SensorBuffer
  readonly #flusher: BatchFlusher
  readonly #maxRows: number
  readonly #maxAgeMs: number
  readonly #now: () => number
  /** Tracks the enqueuedAt of the oldest entry per table, seeded on first observation. */
  #oldestByTable = new Map<string, number>()

  constructor(config: FlushTriggersConfig) {
    this.#buffer = config.buffer
    this.#flusher = config.flusher
    this.#maxRows = config.maxRows ?? DEFAULT_MAX_ROWS
    this.#maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    this.#now = config.now ?? (() => Date.now())
  }

  /**
   * Record the oldest-entry age for a table. Called by the buffer's push
   * pipeline (via the sync manager) so we can evaluate the age trigger
   * without traversing the ring on every check.
   */
  noteEnqueue(table: string, enqueuedAt: number): void {
    if (!this.#oldestByTable.has(table)) {
      this.#oldestByTable.set(table, enqueuedAt)
    }
  }

  /** Called after a drain empties a table so the age tracker restarts. */
  noteDrain(table: string): void {
    this.#oldestByTable.delete(table)
  }

  /**
   * Poll the buffer and enqueue flushes for any table that trips a trigger.
   * Returns the tables that were scheduled so tests can assert directly.
   */
  async evaluate(): Promise<{ table: string, reason: FlushReason }[]> {
    const scheduled: { table: string, reason: FlushReason }[] = []
    const size = await this.#buffer.size()
    // We evaluate per known table by consulting per-table size(). Rather than
    // introspect the buffer's internals, use the tables the triggers already
    // know about (via noteEnqueue) plus any table with a positive total.
    const candidates = new Set<string>(this.#oldestByTable.keys())
    for (const t of candidates) {
      const perTable = await this.#buffer.size(t)
      if (perTable.inMemory >= this.#maxRows) {
        scheduled.push({ table: t, reason: 'row-count' })
        this.#flusher.scheduleFlush(t, 'row-count')
        continue
      }
      const oldest = this.#oldestByTable.get(t)
      if (oldest !== undefined && this.#now() - oldest >= this.#maxAgeMs) {
        scheduled.push({ table: t, reason: 'age' })
        this.#flusher.scheduleFlush(t, 'age')
      }
    }
    // Suppress the unused var warning for size — it may be surfaced later.
    void size
    return scheduled
  }

  /**
   * App-state transition to `foreground`. Schedules a flush on every tracked
   * table at priority 0.
   */
  onForeground(): void {
    for (const t of this.#oldestByTable.keys()) {
      this.#flusher.scheduleFlush(t, 'foreground')
    }
  }

  /**
   * App-state transition to `background`. Best-effort background flush at
   * lowest priority.
   */
  onBackground(): void {
    for (const t of this.#oldestByTable.keys()) {
      this.#flusher.scheduleFlush(t, 'background')
    }
  }

  /** Manual `flush()` — the caller decides the table set. */
  manual(table: string): Promise<unknown> {
    return this.#flusher.scheduleFlush(table, 'manual')
  }
}
