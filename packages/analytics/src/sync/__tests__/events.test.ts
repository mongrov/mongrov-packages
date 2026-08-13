/**
 * T-25 — Event bus integration.
 *
 * Coverage:
 *   1. `bindFlushEvents` emits `${table}:insert` on successful flush events.
 *   2. `bindFlushEvents` swallows `flush-failed` (no bus emission).
 *   3. `bindPushEvents` emits `${table}:sync_complete` only for ok pushes
 *      with `rowsPushed > 0`.
 *   4. `R2Pusher` integrates the emitter — successful push fires
 *      `${table}:sync_complete`; empty push does not; failed push does not.
 */

import type { AttachContext } from '../../core/types'

import type { EventBus } from '../events'
import { describe, expect, it, vi } from 'vitest'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { bindFlushEvents, bindPushEvents } from '../events'
import { R2Pusher } from '../pusher'
import { WatermarkStore } from '../watermark'
import { createFakeSqlEngine } from './__fakes__/fake-sql-engine'

const ctx: AttachContext = {
  brand: 'ziva',
  tenantScope: 'family',
  tenantId: 'fam_A',
  userId: 'u1',
}

function makeBus(): EventBus & { calls: Array<{ name: string, payload: unknown }> } {
  const calls: Array<{ name: string, payload: unknown }> = []
  return {
    calls,
    emit: (name, payload) => calls.push({ name, payload }),
  }
}

describe('bindFlushEvents', () => {
  it('emits {table}:insert on flush success', () => {
    const bus = makeBus()
    const emit = bindFlushEvents(bus)
    emit({
      type: 'flushed',
      payload: { table: 'hrv', rowsFlushed: 5, reason: 'row-count', affectedUserIds: ['u1'] },
    })
    expect(bus.calls).toEqual([{
      name: 'hrv:insert',
      payload: { table: 'hrv', rowsFlushed: 5, reason: 'row-count' },
    }])
  })

  it('does not emit on flush-failed', () => {
    const bus = makeBus()
    const emit = bindFlushEvents(bus)
    emit({
      type: 'flush-failed',
      payload: { table: 'hrv', error: new Error('boom') as never },
    })
    expect(bus.calls).toHaveLength(0)
  })
})

describe('bindPushEvents', () => {
  it('emits {table}:sync_complete only when ok and rowsPushed > 0', () => {
    const bus = makeBus()
    const emit = bindPushEvents(bus)
    emit({ table: 'hrv', rowsPushed: 3, ok: true })
    emit({ table: 'hr', rowsPushed: 0, ok: true }) // no-op push, no event
    emit({ table: 'spo2', rowsPushed: 0, ok: false }) // failure, no event
    expect(bus.calls).toEqual([{
      name: 'hrv:sync_complete',
      payload: { table: 'hrv', rowsPushed: 3 },
    }])
  })
})

describe('R2Pusher event integration', () => {
  it('emits sync_complete after successful push with rows', async () => {
    const { kv } = createFakeKV()
    const watermark = new WatermarkStore({ kv, now: () => new Date('2026-06-01T00:00:00Z'), defaultRetentionMs: 86_400_000 })
    const fake = createFakeSqlEngine()
    const bus = makeBus()
    const pusher = new R2Pusher({
      engine: fake.engine,
      watermark,
      emit: bindPushEvents(bus),
    })
    fake.mockNext([{ max_ts: '2026-06-15T00:00:00.000Z', row_count: 4 }])
    fake.mockNext([]) // INSERT

    await pusher.push('hrv', ctx)
    expect(bus.calls).toEqual([{
      name: 'hrv:sync_complete',
      payload: { table: 'hrv', rowsPushed: 4 },
    }])
  })

  it('does not emit when push has no new rows', async () => {
    const { kv } = createFakeKV()
    const watermark = new WatermarkStore({ kv, now: () => new Date('2026-06-01T00:00:00Z'), defaultRetentionMs: 86_400_000 })
    const fake = createFakeSqlEngine()
    const bus = makeBus()
    const pusher = new R2Pusher({
      engine: fake.engine,
      watermark,
      emit: bindPushEvents(bus),
    })
    fake.mockNext([{ max_ts: null, row_count: 0 }])
    await pusher.push('hrv', ctx)
    expect(bus.calls).toHaveLength(0)
  })

  it('does not emit when push fails', async () => {
    const { kv } = createFakeKV()
    const watermark = new WatermarkStore({ kv, now: () => new Date('2026-06-01T00:00:00Z'), defaultRetentionMs: 86_400_000 })
    const fake = createFakeSqlEngine()
    const bus = makeBus()
    const emitSpy = vi.fn(bindPushEvents(bus))
    const pusher = new R2Pusher({
      engine: fake.engine,
      watermark,
      emit: emitSpy,
    })
    fake.throwNext(new Error('connection reset'))
    await pusher.push('hrv', ctx)
    // Emitter is still called with a `{ ok: false }` result, but the bus
    // must remain silent (guarded inside `bindPushEvents`).
    expect(emitSpy).toHaveBeenCalledOnce()
    expect(bus.calls).toHaveLength(0)
  })
})
