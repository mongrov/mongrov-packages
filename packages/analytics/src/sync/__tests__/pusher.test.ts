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
import type { RingConfigClose } from '../mapper/ring-config'
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
    expect(fake.calls[1]!.sql).toMatch(/INSERT INTO zone_fam_A.default.hrv SELECT \* FROM main\.hrv/)
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

describe('R2Pusher time column resolution', () => {
  it('uses ts_start for sleep_session (non-ts time column)', async () => {
    const { pusher, fake } = newPusher()
    fake.mockNext([{ max_ts: '2026-06-01T00:00:00.000Z', row_count: 1 }])
    fake.mockNext([])
    await pusher.push('sleep_session', ctx)
    expect(fake.calls[0]!.sql).toMatch(/SELECT MAX\(ts_start\)/)
    expect(fake.calls[0]!.sql).toMatch(/WHERE ts_start > \$watermark/)
    expect(fake.calls[1]!.sql).toMatch(/WHERE ts_start > \$watermark/)
  })

  it('uses valid_from for device_config (SCD-2 time column)', async () => {
    const { pusher, fake } = newPusher()
    fake.mockNext([{ max_ts: '2026-06-01T00:00:00.000Z', row_count: 1 }])
    fake.mockNext([])
    await pusher.push('device_config', ctx)
    expect(fake.calls[0]!.sql).toMatch(/SELECT MAX\(valid_from\)/)
    expect(fake.calls[0]!.sql).toMatch(/WHERE valid_from > \$watermark/)
    expect(fake.calls[1]!.sql).toMatch(/WHERE valid_from > \$watermark/)
  })
})

describe('R2Pusher.pushCloses', () => {
  const NOW = new Date('2026-06-17T12:00:00Z')
  const closes: RingConfigClose[] = [
    { device_id: 'ring_1', metric: 'heart_rate', valid_to: NOW },
    { device_id: 'ring_1', metric: 'spo2', valid_to: NOW },
  ]

  it('issues one UPDATE per close bound to (device_id, metric, family_id, valid_to IS NULL)', async () => {
    const { pusher, fake } = newPusher()
    fake.mockNext([])
    fake.mockNext([])

    const result = await pusher.pushCloses(closes, ctx)
    expect(result).toEqual({ table: 'device_config', rowsPushed: 2, ok: true })
    expect(fake.calls).toHaveLength(2)
    for (const call of fake.calls) {
      expect(call.sql).toMatch(/UPDATE zone_fam_A.default.device_config/)
      expect(call.sql).toMatch(/valid_to IS NULL/)
      expect(call.params?.family_id).toBe('fam_A')
      expect(call.params?.valid_to).toBe(NOW.toISOString())
    }
    expect(fake.calls[0]!.params?.metric).toBe('heart_rate')
    expect(fake.calls[1]!.params?.metric).toBe('spo2')
  })

  it('empty closes returns ok without issuing SQL', async () => {
    const { pusher, fake } = newPusher()
    const result = await pusher.pushCloses([], ctx)
    expect(result).toEqual({ table: 'device_config', rowsPushed: 0, ok: true })
    expect(fake.calls).toHaveLength(0)
  })

  it('401 triggers refreshToken and retries once', async () => {
    const refreshToken = vi.fn().mockResolvedValue(undefined)
    const { pusher, fake } = newPusher(refreshToken)
    fake.throwNext(new Error('401 unauthorized'))
    fake.mockNext([])
    fake.mockNext([])

    const result = await pusher.pushCloses(closes, ctx)
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect(result.rowsPushed).toBe(2)
  })

  it('non-401 error surfaces push_failed', async () => {
    const { pusher, fake } = newPusher()
    fake.throwNext(new Error('connection reset'))
    const result = await pusher.pushCloses(closes, ctx)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('push_failed')
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
    fake.mockWhen('INSERT INTO zone_fam_A.default.hrv', { type: 'rows', rows: [] })
    fake.mockWhen('FROM main.hr ', { type: 'throw', err: new Error('boom') })

    const results = await pusher.pushAll(['hrv', 'hr'], ctx)
    expect(results).toHaveLength(2)
    const byTable = Object.fromEntries(results.map(r => [r.table, r]))
    expect(byTable.hrv!.ok).toBe(true)
    expect(byTable.hr!.ok).toBe(false)
    expect(byTable.hr!.error?.code).toBe('push_failed')
  })
})
