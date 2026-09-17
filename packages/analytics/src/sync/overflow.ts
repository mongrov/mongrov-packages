/**
 * Overflow store (T-11).
 *
 * Persistent tail of the sensor buffer. When the in-memory ring exceeds its
 * byte budget, chunks spill to the KVStore keyed by
 *   `sync:overflow:{table}:{seq}`
 *
 * A per-table manifest at `sync:overflow:{table}:manifest` holds the ordered
 * list of live seq numbers so we can drain / count / clear without a
 * `list()` op on KVStore. The manifest is kept in-memory too — hydrated once
 * per table on first access and mutated in lock-step with the KV writes.
 *
 * Ordering guarantee: seq numbers are monotonic per table, so a FIFO drain
 * over the manifest reproduces enqueue order.
 */

import type { KVStore } from '../core/types'
import type { BufferEntry } from './types'

const KEY_PREFIX = 'sync:overflow'

function chunkKey(table: string, seq: number): string {
  return `${KEY_PREFIX}:${table}:${seq}`
}
function manifestKey(table: string): string {
  return `${KEY_PREFIX}:${table}:manifest`
}

interface TableState {
  /** Ordered seq numbers currently persisted for the table (FIFO order). */
  seqs: number[]
  /** Monotonic counter for new writes. */
  nextSeq: number
  /** True once the manifest has been hydrated from KV for this table. */
  hydrated: boolean
  /**
   * Seqs handed to an in-flight flush and not yet acked or released. In
   * memory only, deliberately: after a kill nothing is leased, so every
   * surviving chunk is offered to the next flush.
   */
  leased: Set<number>
}

export class OverflowStore {
  readonly #kv: KVStore
  readonly #tables = new Map<string, TableState>()

  constructor(kv: KVStore) {
    this.#kv = kv
  }

  async push(table: string, entry: BufferEntry): Promise<void> {
    const state = await this.#hydrate(table)
    const seq = state.nextSeq++
    state.seqs.push(seq)
    await this.#kv.set(chunkKey(table, seq), entry)
    await this.#kv.set(manifestKey(table), {
      seqs: state.seqs,
      nextSeq: state.nextSeq,
    })
  }

  /**
   * Drain up to `limit` entries in FIFO order. Reads + deletes them from KV
   * and updates the manifest. If `limit` is omitted, drains everything.
   */
  async drain(table: string, limit?: number): Promise<BufferEntry[]> {
    const state = await this.#hydrate(table)
    const take = limit ?? state.seqs.length
    if (take <= 0 || state.seqs.length === 0)
      return []

    const drained: BufferEntry[] = []
    const seqsToRemove = state.seqs.slice(0, take)
    for (const seq of seqsToRemove) {
      const entry = await this.#kv.get<BufferEntry>(chunkKey(table, seq))
      if (entry)
        drained.push(entry)
      await this.#kv.delete(chunkKey(table, seq))
    }
    state.seqs = state.seqs.slice(take)
    if (state.seqs.length === 0) {
      // Reset nextSeq so a re-fill after a full drain doesn't leak counter
      // growth. Manifest is deleted rather than persisted as empty.
      state.nextSeq = 0
      await this.#kv.delete(manifestKey(table))
    }
    else {
      await this.#kv.set(manifestKey(table), {
        seqs: state.seqs,
        nextSeq: state.nextSeq,
      })
    }
    return drained
  }

  /**
   * Hand every live, unleased entry to a flush WITHOUT removing it.
   *
   * The two-phase half of #54. `drain` deletes before the caller has written
   * anywhere, so a kill between the two lost rows that were durable. A lease
   * leaves them on disk until `ack` — after the write commits — and marks
   * them so an overlapping flush of the same table does not take them too.
   * Marked synchronously, before the first await, which is what makes two
   * concurrent leases disjoint.
   */
  async lease(table: string): Promise<{ entries: BufferEntry[], seqs: number[] }> {
    const state = await this.#hydrate(table)
    const seqs = state.seqs.filter(seq => !state.leased.has(seq))
    for (const seq of seqs) state.leased.add(seq)
    const entries: BufferEntry[] = []
    for (const seq of seqs) {
      const entry = await this.#kv.get<BufferEntry>(chunkKey(table, seq))
      if (entry)
        entries.push(entry)
    }
    return { entries, seqs }
  }

  /** The leased entries were written: delete exactly those. */
  async ack(table: string, seqs: readonly number[]): Promise<void> {
    if (seqs.length === 0)
      return
    const state = await this.#hydrate(table)
    const done = new Set(seqs)
    for (const seq of seqs) {
      await this.#kv.delete(chunkKey(table, seq))
      state.leased.delete(seq)
    }
    state.seqs = state.seqs.filter(seq => !done.has(seq))
    if (state.seqs.length === 0) {
      state.nextSeq = 0
      await this.#kv.delete(manifestKey(table))
    }
    else {
      await this.#kv.set(manifestKey(table), {
        seqs: state.seqs,
        nextSeq: state.nextSeq,
      })
    }
  }

  /** The write failed: the entries stay on disk for the next flush. */
  async release(table: string, seqs: readonly number[]): Promise<void> {
    const state = await this.#hydrate(table)
    for (const seq of seqs) state.leased.delete(seq)
  }

  async count(table: string): Promise<number> {
    const state = await this.#hydrate(table)
    return state.seqs.length
  }

  async clear(table: string): Promise<void> {
    const state = await this.#hydrate(table)
    for (const seq of state.seqs) {
      await this.#kv.delete(chunkKey(table, seq))
    }
    state.seqs = []
    state.nextSeq = 0
    await this.#kv.delete(manifestKey(table))
  }

  async #hydrate(table: string): Promise<TableState> {
    let state = this.#tables.get(table)
    if (state && state.hydrated)
      return state

    if (!state) {
      state = { seqs: [], nextSeq: 0, hydrated: false, leased: new Set() }
      this.#tables.set(table, state)
    }

    const manifest = await this.#kv.get<{ seqs: number[], nextSeq: number }>(
      manifestKey(table),
    )
    if (manifest && Array.isArray(manifest.seqs)) {
      state.seqs = [...manifest.seqs]
      state.nextSeq = Number.isFinite(manifest.nextSeq) ? manifest.nextSeq : 0
    }
    state.hydrated = true
    return state
  }
}
