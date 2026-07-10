import { describe, expect, it } from 'vitest'

import {
  clearLastAttach,
  LAST_ATTACH_TTL_MS,
  loadLastAttach,
  loadRetentionOverride,
  saveLastAttach,
  saveRetentionOverride,
} from '../persistence'
import type { AttachContext } from '../types'

import { createFakeKV } from './__fakes__/fake-kv'

const CTX: AttachContext = {
  brand: 'brandA',
  tenantScope: 'family',
  tenantId: 'fam123',
  userId: 'user-1',
}

describe('last-attach persistence', () => {
  it('round-trips a fresh ctx', async () => {
    const { kv } = createFakeKV()
    await saveLastAttach(kv, CTX, 1_000)
    const restored = await loadLastAttach(kv, CTX.brand, 1_500)
    expect(restored).toEqual(CTX)
  })

  it('returns null when nothing stored', async () => {
    const { kv } = createFakeKV()
    expect(await loadLastAttach(kv, 'brandA')).toBeNull()
  })

  it('returns null and deletes when stored ctx is older than 24h', async () => {
    const { kv, store } = createFakeKV()
    await saveLastAttach(kv, CTX, 0)
    const now = LAST_ATTACH_TTL_MS + 1
    const restored = await loadLastAttach(kv, CTX.brand, now)
    expect(restored).toBeNull()
    // Stale entry cleaned up as a side effect.
    expect(store.has(`analytics:last-attach:${CTX.brand}`)).toBe(false)
  })

  it('clearLastAttach removes the entry', async () => {
    const { kv, store } = createFakeKV()
    await saveLastAttach(kv, CTX)
    expect(store.size).toBeGreaterThan(0)
    await clearLastAttach(kv, CTX.brand)
    expect(await loadLastAttach(kv, CTX.brand)).toBeNull()
  })

  it('scopes per brand — brandB entry is not returned for brandA', async () => {
    const { kv } = createFakeKV()
    await saveLastAttach(kv, { ...CTX, brand: 'brandB' })
    expect(await loadLastAttach(kv, 'brandA')).toBeNull()
    expect(await loadLastAttach(kv, 'brandB')).toEqual({ ...CTX, brand: 'brandB' })
  })
})

describe('retention override persistence', () => {
  it('round-trips a user override for (brand, tenantId, userId)', async () => {
    const { kv } = createFakeKV()
    await saveRetentionOverride(kv, CTX, 180)
    expect(await loadRetentionOverride(kv, CTX)).toBe(180)
  })

  it('returns null when no override is stored', async () => {
    const { kv } = createFakeKV()
    expect(await loadRetentionOverride(kv, CTX)).toBeNull()
  })

  it('overwrites prior override for the same key', async () => {
    const { kv } = createFakeKV()
    await saveRetentionOverride(kv, CTX, 60)
    await saveRetentionOverride(kv, CTX, 120)
    expect(await loadRetentionOverride(kv, CTX)).toBe(120)
  })

  it('scopes per user — user-2 override does not surface for user-1', async () => {
    const { kv } = createFakeKV()
    await saveRetentionOverride(kv, { ...CTX, userId: 'user-2' }, 30)
    expect(await loadRetentionOverride(kv, CTX)).toBeNull()
    expect(await loadRetentionOverride(kv, { ...CTX, userId: 'user-2' })).toBe(30)
  })
})
