/**
 * PendingClosesStore unit coverage.
 *
 *   1. Enqueue → drain round-trip (Date restored, order preserved).
 *   2. Enqueue is additive across calls; drain clears the queue.
 *   3. Drain on empty queue returns [] and touches no keys.
 *   4. Requeue prepends failed closes so retries run first.
 *   5. Keys are scoped to `(brand, tenantId)` — no cross-tenant bleed.
 *   6. Empty enqueue / empty requeue is a no-op (no KV write).
 */

import type { AttachContext } from '../../core/types'

import type { RingConfigClose } from '../mapper/ring-config'
import { describe, expect, it } from 'vitest'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { PendingClosesStore } from '../pending_closes'

const ctx: Pick<AttachContext, 'brand' | 'tenantId'> = {
  brand: 'ziva',
  tenantId: 'fam_A',
}

const close1: RingConfigClose = {
  device_id: 'ring_8047',
  metric: 'heart_rate',
  valid_to: new Date('2026-06-17T12:00:00Z'),
}

const close2: RingConfigClose = {
  device_id: 'ring_8047',
  metric: 'spo2',
  valid_to: new Date('2026-06-17T12:00:00Z'),
}

describe('PendingClosesStore', () => {
  it('enqueue → drain round-trips shape and restores Date', async () => {
    const { kv } = createFakeKV()
    const store = new PendingClosesStore(kv)
    await store.enqueue(ctx, [close1, close2])
    const drained = await store.drain(ctx)
    expect(drained).toHaveLength(2)
    expect(drained[0].valid_to).toBeInstanceOf(Date)
    expect(drained[0].valid_to.toISOString()).toBe(close1.valid_to.toISOString())
    expect(drained[0].metric).toBe('heart_rate')
    expect(drained[1].metric).toBe('spo2')
  })

  it('enqueue is additive across calls; drain clears the queue', async () => {
    const { kv, store: kvStore } = createFakeKV()
    const store = new PendingClosesStore(kv)
    await store.enqueue(ctx, [close1])
    await store.enqueue(ctx, [close2])
    const first = await store.drain(ctx)
    expect(first).toHaveLength(2)
    expect(kvStore.has('analytics:pending_closes:ziva:fam_A')).toBe(false)
    const second = await store.drain(ctx)
    expect(second).toEqual([])
  })

  it('drain on empty queue returns [] and writes nothing', async () => {
    const { kv, store: kvStore } = createFakeKV()
    const store = new PendingClosesStore(kv)
    const drained = await store.drain(ctx)
    expect(drained).toEqual([])
    expect(kvStore.size).toBe(0)
  })

  it('requeue prepends failed closes ahead of existing queue', async () => {
    const { kv } = createFakeKV()
    const store = new PendingClosesStore(kv)
    // First a normal enqueue leaves a pending item.
    await store.enqueue(ctx, [close2])
    // A failed cycle re-inserts close1 with prepend semantics.
    await store.requeue(ctx, [close1])
    const drained = await store.drain(ctx)
    expect(drained.map(c => c.metric)).toEqual(['heart_rate', 'spo2'])
  })

  it('keys are scoped by brand + tenantId', async () => {
    const { kv } = createFakeKV()
    const store = new PendingClosesStore(kv)
    await store.enqueue(ctx, [close1])
    const otherCtx = { brand: 'ziva', tenantId: 'fam_B' }
    const other = await store.drain(otherCtx)
    expect(other).toEqual([])
    // Original queue still intact.
    expect(await store.drain(ctx)).toHaveLength(1)
  })

  it('empty enqueue / requeue is a no-op', async () => {
    const { kv, store: kvStore } = createFakeKV()
    const store = new PendingClosesStore(kv)
    await store.enqueue(ctx, [])
    await store.requeue(ctx, [])
    expect(kvStore.size).toBe(0)
  })
})
