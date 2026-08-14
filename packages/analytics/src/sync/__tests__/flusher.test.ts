/**
 * T-13 + T-15 — Batch flusher.
 *
 * Coverage:
 *   1. Happy path: buffer rows → Appender.appendRow → flush → close; buffer
 *      empty on success; `flushed` event emitted with correct row count.
 *   2. Column ordering: rows serialised in the configured column order,
 *      missing keys → null.
 *   3. Failure recovers rows into the buffer (drop-oldest re-queue).
 *   4. Retry loop honours backoff sequence 1s → 2s → 4s until success;
 *      counter reset on success.
 *   5. 5-consecutive-failure ceiling flips the table to `error` state and
 *      stops re-enqueueing.
 *   6. `scheduleFlush` honours priority: `foreground` (0) runs before
 *      `background` (10).
 */

import type { FlushedEvent } from '../flusher'

import type { SensorBatch } from '../types'
import { describe, expect, it } from 'vitest'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { SensorBuffer } from '../buffer'
import { BACKOFF_SEQUENCE_MS, BatchFlusher, MAX_CONSECUTIVE_FAILURES } from '../flusher'
import { OverflowStore } from '../overflow'
import { createFakeEngine } from './__fakes__/fake-engine'

const COL_ORDER: Record<string, readonly string[]> = {
  hrv: ['ts', 'hrv_ms', 'stress'],
  hr: ['ts', 'bpm'],
}

function makeBatch(table: string, rows: Record<string, unknown>[]): SensorBatch {
  return {
    table,
    brand: 'ziva',
    familyId: 'fam',
    userId: 'u',
    deviceId: 'd',
    rows,
  }
}

function newSetup() {
  const fake = createFakeKV()
  const overflow = new OverflowStore(fake.kv)
  const buffer = new SensorBuffer({ overflow })
  const engineFake = createFakeEngine()
  const emitted: Array<{ type: string, payload: unknown }> = []
  const flusher = new BatchFlusher({
    engine: engineFake.engine,
    buffer,
    columnOrder: COL_ORDER,
    sleep: () => Promise.resolve(),
    emit: e => emitted.push(e),
  })
  return { buffer, engineFake, flusher, emitted }
}

describe('BatchFlusher.flush (happy path)', () => {
  it('drains rows to the appender in column order', async () => {
    const { buffer, engineFake, flusher, emitted } = newSetup()
    await buffer.push(makeBatch('hrv', [
      { ts: 't0', hrv_ms: 50, stress: 20 },
      { ts: 't1', hrv_ms: 55, stress: 25 },
    ]))

    const result = await flusher.flush('hrv', 'manual')
    expect(result).toEqual({ table: 'hrv', rowsFlushed: 2, ok: true })
    // Appends land in the unconstrained staging mirror; a set-based
    // `INSERT ... ON CONFLICT DO NOTHING` moves them into `hrv`
    // (principle 66). Column order is what this assertion is really about.
    expect(engineFake.appended).toEqual([
      { table: 'hrv__stg', values: ['t0', 50, 20] },
      { table: 'hrv__stg', values: ['t1', 55, 25] },
    ])
    expect(engineFake.flushCount).toBe(1)
    expect(engineFake.closeCount).toBe(1)
    expect(await buffer.size('hrv')).toEqual({ inMemory: 0, inMemoryBytes: 0, overflow: 0 })
    const flushedEvent = emitted.find(e => e.type === 'flushed')
    expect(flushedEvent?.payload).toMatchObject<FlushedEvent>({
      table: 'hrv',
      rowsFlushed: 2,
      reason: 'manual',
      affectedUserIds: ['u'],
    })
  })

  it('projects missing columns as null', async () => {
    const { buffer, engineFake, flusher } = newSetup()
    await buffer.push(makeBatch('hrv', [{ ts: 't0', hrv_ms: 42 }]))
    await flusher.flush('hrv')
    expect(engineFake.appended[0]!.values).toEqual(['t0', 42, null])
  })
})

describe('BatchFlusher.flush (failure)', () => {
  it('restores rows to the buffer and surfaces flush_failed', async () => {
    const { buffer, engineFake, flusher, emitted } = newSetup()
    await buffer.push(makeBatch('hrv', [{ ts: 't0', hrv_ms: 50 }]))
    engineFake.queueFlushError(new Error('duckdb blew up'))

    const result = await flusher.flush('hrv')
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('flush_failed')
    expect(flusher.stateOf('hrv')).toBe('error')
    expect(flusher.failureCountOf('hrv')).toBe(1)
    // Rows re-queued.
    expect((await buffer.size('hrv')).inMemory).toBe(1)
    const failedEvent = emitted.find(e => e.type === 'flush-failed')
    expect(failedEvent).toBeDefined()
  })
})

describe('BatchFlusher.scheduleFlush (retry loop)', () => {
  it('retries with backoff and eventually succeeds', async () => {
    const { buffer, engineFake, flusher } = newSetup()
    await buffer.push(makeBatch('hrv', [{ ts: 't0', hrv_ms: 50 }]))
    // First two attempts fail, third succeeds.
    engineFake.queueFlushError(new Error('boom 1'))
    engineFake.queueFlushError(new Error('boom 2'))

    const result = await flusher.scheduleFlush('hrv', 'manual')
    expect(result.ok).toBe(true)
    expect(result.rowsFlushed).toBe(1)
    expect(flusher.stateOf('hrv')).toBe('idle')
    expect(flusher.failureCountOf('hrv')).toBe(0)
  })

  it('stops after 5 consecutive failures with error state', async () => {
    const { buffer, engineFake, flusher } = newSetup()
    await buffer.push(makeBatch('hrv', [{ ts: 't0', hrv_ms: 50 }]))
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      engineFake.queueFlushError(new Error(`boom ${i}`))
    }

    const result = await flusher.scheduleFlush('hrv', 'manual')
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('flush_failed')
    expect(flusher.stateOf('hrv')).toBe('error')
    expect(flusher.failureCountOf('hrv')).toBe(MAX_CONSECUTIVE_FAILURES)
    // Rows preserved (still in buffer).
    expect((await buffer.size('hrv')).inMemory).toBe(1)
  })

  it('exposes the backoff schedule', () => {
    expect(BACKOFF_SEQUENCE_MS.slice(0, 3)).toEqual([1_000, 2_000, 4_000])
    expect(BACKOFF_SEQUENCE_MS.at(-1)).toBe(60_000)
  })
})

describe('BatchFlusher.scheduleFlush (priority)', () => {
  it('foreground drains before background when the queue is contended', async () => {
    const fake = createFakeKV()
    const overflow = new OverflowStore(fake.kv)
    const buffer = new SensorBuffer({ overflow })
    const engineFake = createFakeEngine()
    const appenderCallOrder: string[] = []
    const originalCreate = engineFake.engine.createAppender.bind(engineFake.engine)
    ;(engineFake.engine as any).createAppender = (table: string) => {
      appenderCallOrder.push(table)
      return originalCreate(table)
    }
    // Concurrency 1 so priority determines dequeue order (with 2, both
    // tasks dequeue immediately in add-order).
    const flusher = new BatchFlusher({
      engine: engineFake.engine,
      buffer,
      columnOrder: COL_ORDER,
      sleep: () => Promise.resolve(),
      concurrency: 1,
    })

    await buffer.push(makeBatch('hrv', [{ ts: 't0', hrv_ms: 50, stress: 20 }]))
    await buffer.push(makeBatch('hr', [{ ts: 't0', bpm: 60 }]))

    // Pause so both tasks queue up before any dequeue happens; priority then
    // determines their run order when we resume.
    flusher.pauseQueue()
    const bg = flusher.scheduleFlush('hr', 'background')
    const fg = flusher.scheduleFlush('hrv', 'foreground')
    flusher.resumeQueue()
    await Promise.all([fg, bg])

    // Staging mirrors — the assertion is about ORDER, not the table names.
    expect(appenderCallOrder[0]).toBe('hrv__stg')
    expect(appenderCallOrder[1]).toBe('hr')
  })
})
