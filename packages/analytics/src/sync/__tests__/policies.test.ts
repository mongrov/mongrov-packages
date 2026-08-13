/**
 * T-12 — Overflow policies.
 *
 * Coverage:
 *   1. drop-oldest spills the oldest ring entries into OverflowStore when the
 *      byte budget is exceeded; incoming entry stays in memory.
 *   2. drop-newest rejects the incoming push and fires onDrop with row count.
 *   3. block awaits drain() before accepting subsequent pushes.
 */

import type { SensorBatch } from '../types'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { SensorBuffer } from '../buffer'
import { OverflowStore } from '../overflow'

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

describe('SensorBuffer overflow policies', () => {
  let overflow: OverflowStore

  beforeEach(() => {
    const fake = createFakeKV()
    overflow = new OverflowStore(fake.kv)
  })

  it('drop-oldest spills the oldest ring entries to durable overflow', async () => {
    // Byte budget sized to hold exactly one ~9-byte entry at a time
    // (`JSON.stringify([{i: 0}])` is 9 chars). Push seed 0, then subsequent
    // pushes must spill the oldest entry into overflow first.
    const buffer = new SensorBuffer({
      overflow,
      maxBufferBytes: 15,
      policy: 'drop-oldest',
    })

    await buffer.push(makeBatch('hrv', 1, 0)) // seed 0
    await buffer.push(makeBatch('hrv', 1, 1)) // forces seed 0 → overflow
    await buffer.push(makeBatch('hrv', 1, 2)) // forces seed 1 → overflow

    expect(await overflow.count('hrv')).toBe(2)

    const drained = await buffer.drain('hrv')
    // FIFO across overflow + in-memory ring.
    expect(drained.map(e => e.rows[0]!.i)).toEqual([0, 1, 2])
  })

  it('drop-newest rejects incoming push and fires onDrop', async () => {
    const onDrop = vi.fn()
    const buffer = new SensorBuffer({
      overflow,
      maxBufferBytes: 15,
      policy: 'drop-newest',
      onDrop,
    })

    await buffer.push(makeBatch('hrv', 1, 0))
    // Second push exceeds budget — should be rejected, not stored.
    await buffer.push(makeBatch('hrv', 5, 1))

    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(onDrop).toHaveBeenCalledWith({
      table: 'hrv',
      droppedRowCount: 5,
      reason: 'drop-newest',
    })

    // Drop-newest never writes to durable overflow.
    expect(await overflow.count('hrv')).toBe(0)

    const drained = await buffer.drain('hrv')
    expect(drained).toHaveLength(1)
    expect(drained[0]!.rows[0]!.i).toBe(0)
  })

  it('block awaits drain() before accepting the pending push', async () => {
    const buffer = new SensorBuffer({
      overflow,
      maxBufferBytes: 15,
      policy: 'block',
    })

    await buffer.push(makeBatch('hrv', 1, 0))

    // Second push should block until drain releases room.
    let resolved = false
    const pending = buffer
      .push(makeBatch('hrv', 1, 1))
      .then(() => {
        resolved = true
      })

    // Give the microtask queue a tick — pending must still be blocked.
    await Promise.resolve()
    expect(resolved).toBe(false)

    // Drain wakes blockers; the pending push should now complete.
    await buffer.drain('hrv')
    await pending
    expect(resolved).toBe(true)

    const drained = await buffer.drain('hrv')
    expect(drained.map(e => e.rows[0]!.i)).toEqual([1])
  })
})
