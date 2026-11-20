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

import type { AttachContext } from '../../core/types'
import { describe, expect, it, vi } from 'vitest'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { R2Pusher } from '../pusher'
import { WatermarkStore } from '../watermark'
import { createFakeSqlEngine } from './__fakes__/fake-sql-engine'

const ctx: AttachContext = {
  brand: 'acme',
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
    expect(kvStore.get('analytics:watermark:acme:fam_A:hrv:push')).toBe('2026-06-01T00:00:00.000Z')
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
    expect(kvStore.has('analytics:watermark:acme:fam_A:hrv:push')).toBe(false)
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
})

/**
 * `pushRemote`: arbitrary statements against one remote table (a pack's
 * after-push step), with the push path's auth retry and error mapping.
 */
describe('R2Pusher.pushRemote', () => {
  /** Two UPDATEs against the remote table; resolves with how many it ran. */
  const run = async (remoteTable: string, execute: (sql: string, params?: Record<string, unknown>) => Promise<unknown>) => {
    for (const id of ['a', 'b'])
      await execute(`UPDATE ${remoteTable} SET closed = true WHERE id = $id`, { id })
    return 2
  }

  it('hands the callback the tenant\'s remote table and an executor on the engine', async () => {
    const { pusher, fake } = newPusher()
    fake.mockNext([])
    fake.mockNext([])
    const result = await pusher.pushRemote('item', ctx, run)
    expect(result).toEqual({ table: 'item', rowsPushed: 2, ok: true })
    expect(fake.calls.map(c => [c.sql, c.params])).toEqual([
      ['UPDATE zone_fam_A.default.item SET closed = true WHERE id = $id', { id: 'a' }],
      ['UPDATE zone_fam_A.default.item SET closed = true WHERE id = $id', { id: 'b' }],
    ])
  })

  it('a callback with nothing to do issues no SQL', async () => {
    const { pusher, fake } = newPusher()
    const result = await pusher.pushRemote('item', ctx, async () => 0)
    expect(result).toEqual({ table: 'item', rowsPushed: 0, ok: true })
    expect(fake.calls).toHaveLength(0)
  })

  it('401 triggers refreshToken and reruns the callback once', async () => {
    const refreshToken = vi.fn().mockResolvedValue(undefined)
    const { pusher, fake } = newPusher(refreshToken)
    fake.throwNext(new Error('401 unauthorized'))
    fake.mockNext([])
    fake.mockNext([])

    const result = await pusher.pushRemote('item', ctx, run)
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ table: 'item', rowsPushed: 2, ok: true })
  })

  it('non-401 error surfaces push_failed', async () => {
    const { pusher, fake } = newPusher()
    fake.throwNext(new Error('connection reset'))
    const result = await pusher.pushRemote('item', ctx, run)
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
