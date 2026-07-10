/**
 * T-17 + T-18 — R2 pusher.
 *
 * Coverage:
 *   1. Happy path: read watermark → COUNT/MAX → INSERT → advance watermark.
 *   2. No new rows → skips INSERT, ok=true, rowsPushed=0.
 *   3. 401 triggers refreshToken and retries once (which succeeds).
 *   4. Non-401 error surfaces `push_failed` and preserves the watermark.
 *   5. `pushAll` returns per-table results even when one fails.
 */

import { describe, expect, it, vi } from 'vitest'

import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { R2Pusher } from '../pusher'
import { WatermarkStore } from '../watermark'
import { createFakeSqlEngine } from './__fakes__/fake-sql-engine'
import type { AttachContext } from '../../core/types'

const ctx: AttachContext = {
  brand: 'ziva',
  tenantScope: 'family',
  tenantId: 'fam_A',
  userId: 'u1',
}

const now = () => new Date('2026-06-01T00:00:00Z')

function newPusher(refreshToken?: () => Promise<void>) {
  const { kv, store } = createFakeKV()
  const watermark = new WatermarkStore({ kv, now, defaultRetentionMs: 86_400_000 })
  const fake = createFakeSqlEngine()
  const pusher = new R2Pusher({
    engine: fake.engine,
    watermark,
    refreshToken,
  })
  return { pusher, fake, watermark, kvStore: store }
}

describe('R2Pusher.push', () => {
  it('reads watermark → INSERTs → advances watermark on new rows', async () => {
    const { pusher, fake, kvStore } = newPusher()
    fake.mockNext([{ max_ts: '2026-06-01T00:00:00.000Z', row_count: 3 }])
    fake.mockNext([]) // INSERT returns no row payload.

    const result = await pusher.push('hrv', ctx)
    expect(result).toEqual({ table: 'hrv', rowsPushed: 3, ok: true })
    // First call: MAX/COUNT SELECT.
    expect(fake.calls[0]!.sql).toMatch(/SELECT MAX\(ts\)/)
    // Second call: INSERT.
    expect(fake.calls[1]!.sql).toMatch(/INSERT INTO zone_fam_A\.hrv SELECT \* FROM main\.hrv/)
    // Watermark advanced.
    expect(kvStore.get('analytics:watermark:ziva:fam_A:hrv:push')).toBe('2026-06-01T00:00:00.000Z')
  })

  it('skips INSERT when there are no new rows', async () => {
    const { pusher, fake } = newPusher()
    fake.mockNext([{ max_ts: null, row_count: 0 }])
    const result = await pusher.push('hrv', ctx)
    expect(result).toEqual({ table: 'hrv', rowsPushed: 0, ok: true })
    // No INSERT.
    expect(fake.calls).toHaveLength(1)
  })

  it('401 triggers refreshToken and retries once', async () => {
    const refreshToken = vi.fn().mockResolvedValue(undefined)
    const { pusher, fake } = newPusher(refreshToken)
    // First attempt throws 401 on the SELECT.
    fake.throwNext(new Error('401 unauthorized'))
    // Retry: SELECT succeeds, INSERT succeeds.
    fake.mockNext([{ max_ts: '2026-06-01T00:00:00.000Z', row_count: 1 }])
    fake.mockNext([])

    const result = await pusher.push('hrv', ctx)
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect(result.rowsPushed).toBe(1)
  })

  it('non-401 error preserves watermark and surfaces push_failed', async () => {
    const { pusher, fake, kvStore } = newPusher()
    fake.throwNext(new Error('connection reset'))
    const result = await pusher.push('hrv', ctx)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('push_failed')
    // Watermark untouched.
    expect(kvStore.has('analytics:watermark:ziva:fam_A:hrv:push')).toBe(false)
  })
})

describe('R2Pusher.pushAll', () => {
  it('returns per-table results with mixed success/failure', async () => {
    const { pusher, fake } = newPusher()
    // Route each table's SELECT deterministically (concurrent calls race
    // through Promise.allSettled).
    fake.mockWhen('FROM main.hrv', {
      type: 'rows',
      rows: [{ max_ts: '2026-06-01T00:00:00.000Z', row_count: 2 }],
    })
    fake.mockWhen('INSERT INTO zone_fam_A.hrv', { type: 'rows', rows: [] })
    fake.mockWhen('FROM main.hr ', { type: 'throw', err: new Error('boom') })

    const results = await pusher.pushAll(['hrv', 'hr'], ctx)
    expect(results).toHaveLength(2)
    const byTable = Object.fromEntries(results.map(r => [r.table, r]))
    expect(byTable.hrv!.ok).toBe(true)
    expect(byTable.hr!.ok).toBe(false)
    expect(byTable.hr!.error?.code).toBe('push_failed')
  })
})
