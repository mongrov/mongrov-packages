/**
 * T-11 — Overflow store.
 *
 * Coverage:
 *   1. push → count → drain preserves FIFO order across chunks
 *   2. drain(limit) only pulls prefix; residual manifest persists
 *   3. clear() removes both chunk keys and manifest key
 */

import type { BufferEntry } from '../types'

import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { OverflowStore } from '../overflow'

function makeEntry(rows: number, seed = 0): BufferEntry {
  const rowArr = Array.from({ length: rows }, (_, i) => ({ i: seed + i }))
  return {
    rows: rowArr,
    brand: 'ziva',
    familyId: 'fam_A',
    userId: 'u1',
    deviceId: 'dev1',
    enqueuedAt: 1_700_000_000_000 + seed,
    byteSize: JSON.stringify(rowArr).length,
  }
}

describe('OverflowStore', () => {
  let store: OverflowStore
  let kvStore: Map<string, unknown>

  beforeEach(() => {
    const fake = createFakeKV()
    kvStore = fake.store
    store = new OverflowStore(fake.kv)
  })

  it('push → count → drain preserves FIFO order', async () => {
    await store.push('hrv', makeEntry(1, 0))
    await store.push('hrv', makeEntry(1, 1))
    await store.push('hrv', makeEntry(1, 2))
    expect(await store.count('hrv')).toBe(3)

    const drained = await store.drain('hrv')
    expect(drained.map(e => e.rows[0]!.i)).toEqual([0, 1, 2])
    expect(await store.count('hrv')).toBe(0)
    // Manifest deleted when fully drained.
    expect(kvStore.has('sync:overflow:hrv:manifest')).toBe(false)
  })

  it('drain(limit) pulls only prefix and preserves residual manifest', async () => {
    await store.push('hr', makeEntry(1, 0))
    await store.push('hr', makeEntry(1, 1))
    await store.push('hr', makeEntry(1, 2))

    const first = await store.drain('hr', 2)
    expect(first.map(e => e.rows[0]!.i)).toEqual([0, 1])
    expect(await store.count('hr')).toBe(1)
    expect(kvStore.has('sync:overflow:hr:manifest')).toBe(true)

    const rest = await store.drain('hr')
    expect(rest.map(e => e.rows[0]!.i)).toEqual([2])
    expect(await store.count('hr')).toBe(0)
  })

  it('clear() removes chunk keys and manifest key', async () => {
    await store.push('spo2', makeEntry(2, 0))
    await store.push('spo2', makeEntry(2, 1))

    expect(kvStore.size).toBeGreaterThan(0)
    await store.clear('spo2')
    expect(await store.count('spo2')).toBe(0)
    expect(Array.from(kvStore.keys()).filter(k => k.startsWith('sync:overflow:spo2'))).toEqual([])
  })
})
