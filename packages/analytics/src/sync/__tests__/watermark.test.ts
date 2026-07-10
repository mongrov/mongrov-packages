/**
 * T-16 — Watermark store.
 *
 * Coverage:
 *   1. Missing key defaults to `now - retention`.
 *   2. `advance` writes the ISO string; subsequent `get` returns the new value.
 *   3. `push` and `fetch` cursors are independent.
 *   4. `advance` never regresses.
 */

import { describe, expect, it } from 'vitest'

import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { WatermarkStore } from '../watermark'

const now = () => new Date('2026-06-01T00:00:00Z')

describe('WatermarkStore', () => {
  it('missing key defaults to now - retention', async () => {
    const { kv } = createFakeKV()
    const wm = new WatermarkStore({
      kv,
      now,
      defaultRetentionMs: 24 * 60 * 60 * 1000, // 1 day
    })
    const cur = await wm.get('ziva', 'fam_A', 'hrv', 'push')
    expect(cur.toISOString()).toBe('2026-05-31T00:00:00.000Z')
  })

  it('advance persists to KV and get returns the new value', async () => {
    const { kv, store } = createFakeKV()
    const wm = new WatermarkStore({ kv, now })
    const ts = new Date('2026-06-01T12:00:00Z')
    await wm.advance('ziva', 'fam_A', 'hrv', 'push', ts)
    expect(store.get('analytics:watermark:ziva:fam_A:hrv:push')).toBe(ts.toISOString())
    const cur = await wm.get('ziva', 'fam_A', 'hrv', 'push')
    expect(cur.toISOString()).toBe(ts.toISOString())
  })

  it('push and fetch cursors are independent', async () => {
    const { kv } = createFakeKV()
    const wm = new WatermarkStore({ kv, now })
    const pushTs = new Date('2026-06-01T10:00:00Z')
    const fetchTs = new Date('2026-06-01T20:00:00Z')
    await wm.advance('ziva', 'fam_A', 'hrv', 'push', pushTs)
    await wm.advance('ziva', 'fam_A', 'hrv', 'fetch', fetchTs)
    expect((await wm.get('ziva', 'fam_A', 'hrv', 'push')).toISOString()).toBe(pushTs.toISOString())
    expect((await wm.get('ziva', 'fam_A', 'hrv', 'fetch')).toISOString()).toBe(fetchTs.toISOString())
  })

  it('advance never regresses', async () => {
    const { kv } = createFakeKV()
    const wm = new WatermarkStore({ kv, now })
    const later = new Date('2026-06-05T00:00:00Z')
    const earlier = new Date('2026-06-01T00:00:00Z')
    await wm.advance('ziva', 'fam_A', 'hrv', 'push', later)
    await wm.advance('ziva', 'fam_A', 'hrv', 'push', earlier)
    expect((await wm.get('ziva', 'fam_A', 'hrv', 'push')).toISOString()).toBe(later.toISOString())
  })
})
