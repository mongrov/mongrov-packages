/**
 * T-10 — Sensor buffer.
 *
 * Coverage:
 *   1. push + drain FIFO round-trip within one table
 *   2. byte counter tracks accumulation and resets on drain
 *   3. size() reports in-memory + overflow totals per table
 *   4. Per-table isolation: hrv and spo2 rings don't cross-contaminate
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { SensorBuffer } from '../buffer'
import { OverflowStore } from '../overflow'
import type { SensorBatch } from '../types'

function makeBatch(table: string, rows: number, seed = 0): SensorBatch {
  return {
    table,
    brand: 'ziva',
    familyId: 'fam_A',
    userId: 'u1',
    deviceId: 'dev1',
    rows: Array.from({ length: rows }, (_, i) => ({ i: seed + i })),
  }
}

describe('SensorBuffer', () => {
  let buffer: SensorBuffer
  let overflow: OverflowStore

  beforeEach(() => {
    const fake = createFakeKV()
    overflow = new OverflowStore(fake.kv)
    buffer = new SensorBuffer({ overflow, maxBufferBytes: 1_000_000 })
  })

  it('push + drain FIFO within one table', async () => {
    await buffer.push(makeBatch('hrv', 1, 0))
    await buffer.push(makeBatch('hrv', 1, 1))
    await buffer.push(makeBatch('hrv', 1, 2))

    const entries = await buffer.drain('hrv')
    expect(entries).toHaveLength(3)
    expect(entries.map(e => e.rows[0]!.i)).toEqual([0, 1, 2])
    expect(await buffer.size('hrv')).toEqual({
      inMemory: 0,
      inMemoryBytes: 0,
      overflow: 0,
    })
  })

  it('byte counter tracks accumulation and resets on drain', async () => {
    await buffer.push(makeBatch('hr', 5))
    const before = await buffer.size('hr')
    expect(before.inMemoryBytes).toBeGreaterThan(0)
    expect(before.inMemory).toBe(5)

    await buffer.drain('hr')
    const after = await buffer.size('hr')
    expect(after.inMemoryBytes).toBe(0)
    expect(after.inMemory).toBe(0)
  })

  it('size() aggregates in-memory + overflow across tables when no arg', async () => {
    await buffer.push(makeBatch('hrv', 2))
    await buffer.push(makeBatch('hr', 3))

    const total = await buffer.size()
    expect(total.inMemory).toBe(5)
    expect(total.inMemoryBytes).toBeGreaterThan(0)
    expect(total.overflow).toBe(0)
  })

  it('per-table isolation: draining hrv leaves spo2 untouched', async () => {
    await buffer.push(makeBatch('hrv', 2, 0))
    await buffer.push(makeBatch('spo2', 3, 100))

    const hrvOut = await buffer.drain('hrv')
    expect(hrvOut.flatMap(e => e.rows)).toEqual([{ i: 0 }, { i: 1 }])

    const spo2Size = await buffer.size('spo2')
    expect(spo2Size.inMemory).toBe(3)

    const spo2Out = await buffer.drain('spo2')
    expect(spo2Out.flatMap(e => e.rows)).toEqual([{ i: 100 }, { i: 101 }, { i: 102 }])
  })
})
