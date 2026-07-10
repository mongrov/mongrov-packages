/**
 * Sensor buffer (T-10 + T-12).
 *
 * In-memory ring per table with byte-budget accounting and pluggable overflow
 * policies. All ops are synchronous except `push` (which may await overflow
 * writes when the ring exceeds its byte budget).
 *
 * Byte accounting: we estimate a row's contribution as
 * `JSON.stringify(rows).length` at push time. This is a rough proxy for the
 * DuckDB Appender's actual memory footprint but is stable and cheap. The
 * budget is a soft limit — one push at a time can exceed it before overflow
 * fires.
 *
 * Overflow policies (T-12):
 *   - `drop-oldest`: when the ring is full, spill the oldest ring entries to
 *     `OverflowStore` until the incoming push fits in memory. Overflow is
 *     durable (MMKV via KVStore) so nothing is actually dropped.
 *   - `drop-newest`: reject the incoming push and increment a dropped
 *     counter. Warning event is emitted via the injected `onDrop` callback.
 *     Data is lost — used only when the app opts in for battery-only sync.
 *   - `block`: `push` awaits an external drain. Implemented via a
 *     `Promise`-based backpressure signal.
 */

import type { OverflowStore } from './overflow'
import type {
  BufferEntry,
  BufferSize,
  OverflowPolicy,
  SensorBatch,
} from './types'

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 // 10 MB

export interface SensorBufferConfig {
  overflow: OverflowStore
  maxBufferBytes?: number
  policy?: OverflowPolicy
  /** Fired when a `drop-newest` policy discards an incoming push. */
  onDrop?: (entry: {
    table: string
    droppedRowCount: number
    reason: 'drop-newest'
  }) => void
  /** Optional clock injection for deterministic tests. */
  now?: () => number
}

export class SensorBuffer {
  readonly #overflow: OverflowStore
  readonly #maxBytes: number
  readonly #policy: OverflowPolicy
  readonly #onDrop: SensorBufferConfig['onDrop']
  readonly #now: () => number

  #rings = new Map<string, BufferEntry[]>()
  #inMemoryBytes = new Map<string, number>()
  #blockWaiters: Map<string, Array<() => void>> = new Map()

  constructor(config: SensorBufferConfig) {
    this.#overflow = config.overflow
    this.#maxBytes = config.maxBufferBytes ?? DEFAULT_MAX_BYTES
    this.#policy = config.policy ?? 'drop-oldest'
    this.#onDrop = config.onDrop
    this.#now = config.now ?? (() => Date.now())
  }

  async push(batch: SensorBatch): Promise<void> {
    const entry: BufferEntry = {
      rows: batch.rows,
      brand: batch.brand,
      familyId: batch.familyId,
      userId: batch.userId,
      deviceId: batch.deviceId,
      enqueuedAt: this.#now(),
      byteSize: estimateBytes(batch.rows),
    }
    await this.#pushEntry(batch.table, entry)
  }

  /**
   * Drain the buffer for a single table. Overflow entries are drained first
   * so FIFO order across in-memory + overflow is preserved.
   */
  async drain(table: string): Promise<BufferEntry[]> {
    const overflow = await this.#overflow.drain(table)
    const ring = this.#rings.get(table) ?? []
    this.#rings.set(table, [])
    this.#inMemoryBytes.set(table, 0)
    // Wake any block-policy waiters now that room is available.
    this.#wakeBlockers(table)
    return [...overflow, ...ring]
  }

  async size(table?: string): Promise<BufferSize> {
    if (table) return this.#sizeOne(table)
    let inMemory = 0
    let inMemoryBytes = 0
    let overflow = 0
    const tables = new Set<string>([
      ...this.#rings.keys(),
      ...this.#inMemoryBytes.keys(),
    ])
    for (const t of tables) {
      const s = await this.#sizeOne(t)
      inMemory += s.inMemory
      inMemoryBytes += s.inMemoryBytes
      overflow += s.overflow
    }
    return { inMemory, inMemoryBytes, overflow }
  }

  async clear(table?: string): Promise<void> {
    if (table) {
      this.#rings.delete(table)
      this.#inMemoryBytes.set(table, 0)
      await this.#overflow.clear(table)
      this.#wakeBlockers(table)
      return
    }
    for (const t of this.#rings.keys()) await this.#overflow.clear(t)
    this.#rings.clear()
    this.#inMemoryBytes.clear()
    for (const t of this.#blockWaiters.keys()) this.#wakeBlockers(t)
  }

  async #pushEntry(table: string, entry: BufferEntry): Promise<void> {
    const currentBytes = this.#inMemoryBytes.get(table) ?? 0
    const wouldOverflow = currentBytes + entry.byteSize > this.#maxBytes

    if (!wouldOverflow) {
      this.#appendInMemory(table, entry)
      return
    }

    switch (this.#policy) {
      case 'drop-oldest': {
        // Spill oldest ring entries to overflow until the incoming push fits.
        const ring = this.#rings.get(table) ?? []
        while (
          ring.length > 0
          && (this.#inMemoryBytes.get(table) ?? 0) + entry.byteSize
          > this.#maxBytes
        ) {
          const oldest = ring.shift()!
          this.#inMemoryBytes.set(
            table,
            (this.#inMemoryBytes.get(table) ?? 0) - oldest.byteSize,
          )
          await this.#overflow.push(table, oldest)
        }
        this.#rings.set(table, ring)
        // If the incoming entry itself exceeds the budget, park it in
        // overflow directly rather than blowing the ring.
        if (entry.byteSize > this.#maxBytes) {
          await this.#overflow.push(table, entry)
        }
        else {
          this.#appendInMemory(table, entry)
        }
        return
      }
      case 'drop-newest': {
        this.#onDrop?.({
          table,
          droppedRowCount: entry.rows.length,
          reason: 'drop-newest',
        })
        return
      }
      case 'block': {
        // Wait for someone to drain; then retry the push.
        await this.#waitForDrain(table)
        return this.#pushEntry(table, entry)
      }
    }
  }

  #appendInMemory(table: string, entry: BufferEntry): void {
    const ring = this.#rings.get(table) ?? []
    ring.push(entry)
    this.#rings.set(table, ring)
    this.#inMemoryBytes.set(
      table,
      (this.#inMemoryBytes.get(table) ?? 0) + entry.byteSize,
    )
  }

  async #sizeOne(table: string): Promise<BufferSize> {
    const ring = this.#rings.get(table) ?? []
    const inMemoryRows = ring.reduce((a, e) => a + e.rows.length, 0)
    const overflowCount = await this.#overflow.count(table)
    return {
      inMemory: inMemoryRows,
      inMemoryBytes: this.#inMemoryBytes.get(table) ?? 0,
      overflow: overflowCount,
    }
  }

  #waitForDrain(table: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const q = this.#blockWaiters.get(table) ?? []
      q.push(resolve)
      this.#blockWaiters.set(table, q)
    })
  }

  #wakeBlockers(table: string): void {
    const q = this.#blockWaiters.get(table)
    if (!q || q.length === 0) return
    this.#blockWaiters.set(table, [])
    for (const resolve of q) resolve()
  }
}

function estimateBytes(rows: readonly unknown[]): number {
  // Approximation: rough byte count of the JSON encoding. Fast and stable.
  return JSON.stringify(rows).length
}
