/**
 * A process killed mid-flush loses nothing that had reached the overflow
 * store (zivaone_app#54).
 *
 * The overflow store is the buffer's durable tail: rows that spilled past the
 * in-memory budget live in the KVStore (MMKV on device) and survive a kill.
 * `flush()` used to call `buffer.drain()` FIRST, which deleted those chunks
 * from the KVStore, and only then wrote to DuckDB. The failure path restored
 * them — but only into the in-memory ring, and only if the process was alive
 * to run a catch block. A kill during the write (a long history sync, iOS
 * suspending the app) took the only remaining copy with it.
 *
 * A kill cannot be simulated by throwing: the catch block runs and restores
 * the rows, which is exactly the path a real kill never reaches. So the fake
 * appender photographs the KVStore — the "disk" at the instant of death —
 * and the test boots a fresh buffer + flusher over that photograph, as a
 * restarted app would.
 */

import type { KVStore } from '../../core/types'
import type { SensorBatch } from '../types'
import { describe, expect, it } from 'vitest'
import { SensorBuffer } from '../buffer'
import { BatchFlusher } from '../flusher'
import { OverflowStore } from '../overflow'
import { createFakeEngine } from './__fakes__/fake-engine'

const COL_ORDER: Record<string, readonly string[]> = { hr: ['ts', 'bpm'] }

function kvOver(store: Map<string, unknown>): KVStore {
  return {
    async get<T>(key: string) { return store.get(key) as T | undefined },
    async set<T>(key: string, value: T) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

function batch(i: number): SensorBatch {
  return {
    table: 'hr',
    brand: 'ziva',
    familyId: 'fam',
    userId: 'u',
    deviceId: 'd',
    rows: [{ ts: `t${i}`, bpm: 60 + i }],
  }
}

/**
 * A budget of one byte: every push after the first spills to overflow, so
 * the rows under test are the durable ones.
 */
function bufferOver(store: Map<string, unknown>) {
  return new SensorBuffer({ overflow: new OverflowStore(kvOver(store)), maxBufferBytes: 1 })
}

class ProcessKilled extends Error {}

describe('kill mid-flush (zivaone_app#54)', () => {
  it('re-flushes, after restart, every row that was durable when the process died', async () => {
    // ── Life 1: rows arrive, spill to overflow, and a flush starts.
    const disk = new Map<string, unknown>()
    const buffer1 = bufferOver(disk)
    for (let i = 0; i < 5; i += 1) await buffer1.push(batch(i))
    const durableBefore = (await buffer1.size('hr')).overflow
    expect(durableBefore).toBeGreaterThan(0)

    let diskAtDeath: Map<string, unknown> | undefined
    const dying = createFakeEngine()
    const realCreate = dying.engine.createAppender.bind(dying.engine)
    dying.engine.createAppender = (table: string) => {
      const appender = realCreate(table)
      return {
        ...appender,
        appendRow: () => {
          // The instant of death: whatever the KVStore holds now is all a
          // restarted app will ever see.
          diskAtDeath ??= new Map(disk)
          throw new ProcessKilled('killed')
        },
      }
    }
    const flusher1 = new BatchFlusher({
      engine: dying.engine,
      buffer: buffer1,
      columnOrder: COL_ORDER,
      sleep: () => Promise.resolve(),
    })
    await flusher1.flush('hr', 'scheduled')
    expect(diskAtDeath).toBeDefined()

    // ── Life 2: a fresh process over the disk as it was at death.
    const buffer2 = bufferOver(diskAtDeath!)
    const healthy = createFakeEngine()
    const flusher2 = new BatchFlusher({
      engine: healthy.engine,
      buffer: buffer2,
      columnOrder: COL_ORDER,
      sleep: () => Promise.resolve(),
    })
    const result = await flusher2.flush('hr', 'scheduled')

    expect(result.ok).toBe(true)
    expect(result.rowsFlushed).toBe(durableBefore)
    expect(await buffer2.size('hr')).toMatchObject({ overflow: 0 })
  })

  it('removes durable rows only once the write has succeeded', async () => {
    const disk = new Map<string, unknown>()
    const buffer = bufferOver(disk)
    for (let i = 0; i < 4; i += 1) await buffer.push(batch(i))
    const durable = (await buffer.size('hr')).overflow

    let durableDuringWrite = -1
    const engine = createFakeEngine()
    const realCreate = engine.engine.createAppender.bind(engine.engine)
    engine.engine.createAppender = (table: string) => {
      const appender = realCreate(table)
      return {
        ...appender,
        appendRow: (values: unknown[]) => {
          const manifest = disk.get('sync:overflow:hr:manifest') as { seqs: number[] } | undefined
          durableDuringWrite = Math.max(durableDuringWrite, manifest?.seqs.length ?? 0)
          appender.appendRow(values)
        },
      }
    }
    const flusher = new BatchFlusher({
      engine: engine.engine,
      buffer,
      columnOrder: COL_ORDER,
      sleep: () => Promise.resolve(),
    })
    const result = await flusher.flush('hr', 'manual')

    expect(result.ok).toBe(true)
    expect(durableDuringWrite).toBe(durable) // still on disk mid-write
    expect(await buffer.size('hr')).toMatchObject({ overflow: 0 }) // gone after
  })

  it('does not hand the same durable rows to two overlapping flushes', async () => {
    // flushAll calls flush() directly while scheduleFlush goes through the
    // queue, so two flushes of one table can overlap. This already went wrong
    // before the fix — OverflowStore.drain awaited between reading the
    // manifest and trimming it, so both flushes got all four rows — and
    // leaving rows on disk until commit would make it worse without a lease.
    const disk = new Map<string, unknown>()
    const buffer = bufferOver(disk)
    for (let i = 0; i < 4; i += 1) await buffer.push(batch(i))

    const engine = createFakeEngine()
    const flusher = new BatchFlusher({
      engine: engine.engine,
      buffer,
      columnOrder: COL_ORDER,
      sleep: () => Promise.resolve(),
    })
    const [a, b] = await Promise.all([flusher.flush('hr', 'scheduled'), flusher.flush('hr', 'manual')])

    expect(a.rowsFlushed + b.rowsFlushed).toBe(4)
    const staged = engine.appended.filter(x => x.table === 'hr__stg').map(x => x.values[0])
    expect(new Set(staged).size).toBe(staged.length)
  })
})
