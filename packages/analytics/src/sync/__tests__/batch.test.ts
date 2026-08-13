/**
 * Sprint 5 T-11 / T-12 / item (a) — batch lifecycle + `batch:complete`.
 *
 * The behaviour under test is a race fix, so the load-bearing case is the
 * negative one: a batch carrying only `spo2` must NOT wake a rule that
 * needs `sleep_session`.
 */

import type { BatchCompleteEvent, SyncEmitter } from '../flusher'

import { describe, expect, it } from 'vitest'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { SensorBuffer } from '../buffer'
import { bindFlushEvents } from '../events'
import { BatchFlusher } from '../flusher'
import { OverflowStore } from '../overflow'

import { createFakeEngine } from './__fakes__/fake-engine'

const COL_ORDER = {
  spo2: ['ts', 'brand', 'family_id', 'user_id', 'device_id', 'spo2'] as const,
  sleep_session: ['ts_start', 'brand', 'family_id', 'user_id', 'device_id'] as const,
}

function harness(emit?: SyncEmitter) {
  const engineFake = createFakeEngine()
  const buffer = new SensorBuffer({ overflow: new OverflowStore(createFakeKV().kv) })
  const flusher = new BatchFlusher({
    engine: engineFake.engine,
    buffer,
    columnOrder: COL_ORDER as unknown as Record<string, readonly string[]>,
    sleep: () => Promise.resolve(),
    emit,
  })
  return { engineFake, buffer, flusher }
}

async function seed(buffer: SensorBuffer, table: string, userId: string, n = 1) {
  await buffer.push({
    table,
    brand: 'ziva',
    familyId: 'fam1',
    userId,
    deviceId: 'ring_1',
    rows: Array.from({ length: n }, () => ({ ts: new Date(), spo2: 96 })),
  })
}

describe('batch lifecycle', () => {
  it('emits batch-complete once, after every table has flushed', async () => {
    const events: { type: string, payload: unknown }[] = []
    const { buffer, flusher } = harness(e => events.push(e))

    await seed(buffer, 'spo2', 'alice', 3)
    await seed(buffer, 'sleep_session', 'alice', 1)

    const batchId = flusher.beginBatch('scheduled')
    await flusher.flush('spo2', 'scheduled', batchId)
    await flusher.flush('sleep_session', 'scheduled', batchId)

    // Per-table events fire as each table lands...
    expect(events.filter(e => e.type === 'flushed')).toHaveLength(2)
    // ...but nothing batch-level until the batch is closed.
    expect(events.filter(e => e.type === 'batch-complete')).toHaveLength(0)

    flusher.endBatch(batchId)
    const completes = events.filter(e => e.type === 'batch-complete')
    expect(completes).toHaveLength(1)

    const payload = completes[0].payload as BatchCompleteEvent
    expect(payload.affectedTables.sort()).toEqual(['sleep_session', 'spo2'])
    expect(payload.affectedUserIds).toEqual(['alice'])
    expect(payload.rowCounts).toEqual({ spo2: 3, sleep_session: 1 })
    expect(payload.brand).toBe('ziva')
    expect(payload.familyId).toBe('fam1')
    expect(payload.batchId).toBe(batchId)
  })

  it('keeps emitting per-table {table}:insert alongside batch:complete', async () => {
    // The two serve different consumers: invalidation wants to refresh
    // early, rule evaluation must wait for the batch.
    const emitted: string[] = []
    const bus = { emit: (name: string) => { emitted.push(name) } }
    const { buffer, flusher } = harness(bindFlushEvents(bus as never))

    await seed(buffer, 'spo2', 'alice')
    await seed(buffer, 'sleep_session', 'alice')

    const batchId = flusher.beginBatch('scheduled')
    await flusher.flush('spo2', 'scheduled', batchId)
    await flusher.flush('sleep_session', 'scheduled', batchId)
    flusher.endBatch(batchId)

    expect(emitted).toEqual([
      'spo2:insert',
      'sleep_session:insert',
      'batch:complete',
    ])
  })

  it('reports only tables that actually wrote rows', async () => {
    const events: { type: string, payload: unknown }[] = []
    const { buffer, flusher } = harness(e => events.push(e))

    await seed(buffer, 'spo2', 'alice')

    const batchId = flusher.beginBatch('scheduled')
    await flusher.flush('spo2', 'scheduled', batchId)
    // sleep_session had nothing buffered — a no-op flush.
    await flusher.flush('sleep_session', 'scheduled', batchId)
    flusher.endBatch(batchId)

    const payload = (events.find(e => e.type === 'batch-complete')!
      .payload) as BatchCompleteEvent
    // This is the race fix in one assertion: a batch that delivered spo2
    // but no sleep_session must not claim sleep_session landed, or an
    // asleep-context rule would evaluate against a half-written night.
    expect(payload.affectedTables).toEqual(['spo2'])
    expect(payload.rowCounts).toEqual({ spo2: 1 })
  })

  it('emits nothing for an empty batch', async () => {
    const events: { type: string }[] = []
    const { flusher } = harness(e => events.push(e))

    const batchId = flusher.beginBatch('scheduled')
    await flusher.flush('spo2', 'scheduled', batchId)
    expect(flusher.endBatch(batchId)).toBeNull()
    expect(events.filter(e => e.type === 'batch-complete')).toHaveLength(0)
  })

  it('dedupes userIds across tables', async () => {
    const events: { type: string, payload: unknown }[] = []
    const { buffer, flusher } = harness(e => events.push(e))

    await seed(buffer, 'spo2', 'alice')
    await seed(buffer, 'spo2', 'bob')
    await seed(buffer, 'sleep_session', 'alice')

    const batchId = flusher.beginBatch('scheduled')
    await flusher.flush('spo2', 'scheduled', batchId)
    await flusher.flush('sleep_session', 'scheduled', batchId)
    flusher.endBatch(batchId)

    const payload = (events.find(e => e.type === 'batch-complete')!
      .payload) as BatchCompleteEvent
    expect(payload.affectedUserIds.sort()).toEqual(['alice', 'bob'])
  })

  it('leaves un-batched flushes alone', async () => {
    const events: { type: string }[] = []
    const { buffer, flusher } = harness(e => events.push(e))

    await seed(buffer, 'spo2', 'alice')
    await flusher.flush('spo2', 'manual') // no batchId

    expect(events.filter(e => e.type === 'flushed')).toHaveLength(1)
    expect(events.filter(e => e.type === 'batch-complete')).toHaveLength(0)
  })
})

describe('batch bookkeeping is not a lock', () => {
  it('endBatch on an unknown id is a no-op, not a throw', () => {
    const { flusher } = harness()
    expect(flusher.endBatch('never-opened')).toBeNull()
  })

  it('a second endBatch is harmless (retry paths call it twice)', async () => {
    const { buffer, flusher } = harness()
    await seed(buffer, 'spo2', 'alice')

    const batchId = flusher.beginBatch('scheduled')
    await flusher.flush('spo2', 'scheduled', batchId)

    expect(flusher.endBatch(batchId)).not.toBeNull()
    expect(flusher.endBatch(batchId)).toBeNull()
  })

  it('a flush landing after endBatch is dropped, not mis-attributed', async () => {
    // Late arrivals (timeout, retry) must not reopen a reported batch.
    const events: { type: string }[] = []
    const { buffer, flusher } = harness(e => events.push(e))

    const batchId = flusher.beginBatch('scheduled')
    flusher.endBatch(batchId)

    await seed(buffer, 'spo2', 'alice')
    await flusher.flush('spo2', 'scheduled', batchId)

    expect(events.filter(e => e.type === 'batch-complete')).toHaveLength(0)
    expect(flusher.openBatchIds()).toEqual([])
  })

  it('tracks concurrent batches independently', async () => {
    const { buffer, flusher } = harness()
    const a = flusher.beginBatch('scheduled')
    const b = flusher.beginBatch('manual')
    expect(flusher.openBatchIds().sort()).toEqual([a, b].sort())

    await seed(buffer, 'spo2', 'alice')
    await flusher.flush('spo2', 'scheduled', a)

    expect(flusher.endBatch(a)?.affectedTables).toEqual(['spo2'])
    expect(flusher.endBatch(b)).toBeNull()
    expect(flusher.openBatchIds()).toEqual([])
  })

  it('generates a unique id per batch', () => {
    const { flusher } = harness()
    const ids = new Set(Array.from({ length: 50 }, () => flusher.beginBatch()))
    expect(ids.size).toBe(50)
  })
})
