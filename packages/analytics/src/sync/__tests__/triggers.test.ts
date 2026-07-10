/**
 * T-14 — Flush triggers.
 *
 * Coverage:
 *   1. row-count trigger fires when a table hits `maxRows`.
 *   2. age trigger fires when the oldest entry is older than `maxAgeMs`.
 *   3. `onForeground` schedules every tracked table at priority 0.
 *   4. `manual(table)` schedules exactly one table.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { SensorBuffer } from '../buffer'
import { OverflowStore } from '../overflow'
import { BatchFlusher, type FlushReason } from '../flusher'
import { FlushTriggers } from '../triggers'
import type { SensorBatch } from '../types'
import { createFakeEngine } from './__fakes__/fake-engine'

const COL_ORDER = { hrv: ['ts', 'hrv_ms'], hr: ['ts', 'bpm'] }

function batch(table: string, count: number): SensorBatch {
  return {
    table,
    brand: 'ziva',
    familyId: 'f',
    userId: 'u',
    deviceId: 'd',
    rows: Array.from({ length: count }, (_, i) => ({ ts: `t${i}`, hrv_ms: i, bpm: i })),
  }
}

describe('FlushTriggers', () => {
  let buffer: SensorBuffer
  let flusher: BatchFlusher
  let scheduleSpy: ReturnType<typeof vi.spyOn>
  let clock = 1_000

  beforeEach(() => {
    const fake = createFakeKV()
    const overflow = new OverflowStore(fake.kv)
    buffer = new SensorBuffer({ overflow, now: () => clock })
    const engineFake = createFakeEngine()
    flusher = new BatchFlusher({
      engine: engineFake.engine,
      buffer,
      columnOrder: COL_ORDER,
      sleep: () => Promise.resolve(),
    })
    scheduleSpy = vi.spyOn(flusher, 'scheduleFlush').mockImplementation(
      () => Promise.resolve({ table: 'stub', rowsFlushed: 0, ok: true }),
    )
    clock = 1_000
  })

  it('row-count trigger fires when a table hits maxRows', async () => {
    const triggers = new FlushTriggers({
      buffer,
      flusher,
      maxRows: 3,
      maxAgeMs: 10_000_000,
      now: () => clock,
    })
    // Push 3 rows on a single table.
    await buffer.push(batch('hrv', 3))
    triggers.noteEnqueue('hrv', clock)

    const scheduled = await triggers.evaluate()
    expect(scheduled).toEqual([{ table: 'hrv', reason: 'row-count' }])
    expect(scheduleSpy).toHaveBeenCalledWith('hrv', 'row-count')
  })

  it('age trigger fires when the oldest entry is older than maxAgeMs', async () => {
    const triggers = new FlushTriggers({
      buffer,
      flusher,
      maxRows: 10_000,
      maxAgeMs: 100,
      now: () => clock,
    })
    await buffer.push(batch('hrv', 1))
    triggers.noteEnqueue('hrv', clock)

    // Advance the clock past maxAgeMs.
    clock += 500
    const scheduled = await triggers.evaluate()
    expect(scheduled).toEqual([{ table: 'hrv', reason: 'age' }])
    expect(scheduleSpy).toHaveBeenCalledWith('hrv', 'age')
  })

  it('onForeground schedules every tracked table at foreground priority', () => {
    const triggers = new FlushTriggers({ buffer, flusher })
    triggers.noteEnqueue('hrv', 1)
    triggers.noteEnqueue('hr', 2)
    triggers.onForeground()

    const reasons: FlushReason[] = scheduleSpy.mock.calls.map(c => c[1] as FlushReason)
    expect(reasons.every(r => r === 'foreground')).toBe(true)
    const tables = scheduleSpy.mock.calls.map(c => c[0] as string).sort()
    expect(tables).toEqual(['hr', 'hrv'])
  })

  it('manual schedules exactly one table', () => {
    const triggers = new FlushTriggers({ buffer, flusher })
    triggers.manual('hrv')
    expect(scheduleSpy).toHaveBeenCalledTimes(1)
    expect(scheduleSpy).toHaveBeenCalledWith('hrv', 'manual')
  })
})
