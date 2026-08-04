/**
 * Sprint 5 T-07 — measurement-gated watermark cache.
 *
 * The cache gates data visibility, so the tests that matter most are the
 * ones proving it is off by default and that a stale entry can never
 * outlive its TTL.
 */

import { describe, expect, it, vi } from 'vitest'

import { createWatermarkCache, WATERMARK_CACHE_TTL_MS } from '../watermark-cache'
import type { EventBus } from '../types'

/** Minimal pattern-capable bus for invalidation tests. */
function fakeBus() {
  const patterns: { pattern: string, handler: (name: string, p: unknown) => void }[] = []
  const bus: EventBus = {
    emit(name, payload) {
      for (const { pattern, handler } of patterns) {
        const suffix = pattern.replace('*', '')
        if (name.endsWith(suffix)) handler(name, payload)
      }
    },
    subscribe() { return () => {} },
    subscribePattern(pattern, handler) {
      const entry = { pattern, handler: handler as (n: string, p: unknown) => void }
      patterns.push(entry)
      return () => {
        const i = patterns.indexOf(entry)
        if (i >= 0) patterns.splice(i, 1)
      }
    },
  }
  return { bus, patternCount: () => patterns.length }
}

const WM = new Date('2026-07-01T00:00:00.000Z')

describe('disabled by default (measurement gate)', () => {
  it('does not cache — every read hits the loader', async () => {
    const cache = createWatermarkCache()
    const load = vi.fn(async () => WM)

    await cache.get('ziva', 'fam1', 'spo2', load)
    await cache.get('ziva', 'fam1', 'spo2', load)
    await cache.get('ziva', 'fam1', 'spo2', load)

    expect(cache.enabled).toBe(false)
    expect(load).toHaveBeenCalledTimes(3)
    expect(cache.stats().hits).toBe(0)
  })

  it('still instruments latency — that is the point of the gate', async () => {
    // We need latency data BEFORE deciding whether to enable the cache.
    let clock = 0
    const cache = createWatermarkCache({ now: () => clock })
    await cache.get('ziva', 'fam1', 'spo2', async () => {
      clock += 30
      return WM
    })

    const stats = cache.stats()
    expect(stats.latency.samples).toBe(1)
    expect(stats.latency.p95).toBe(30)
  })
})

describe('enabled', () => {
  it('serves a second read from cache', async () => {
    const cache = createWatermarkCache({ enabled: true })
    const load = vi.fn(async () => WM)

    expect(await cache.get('ziva', 'fam1', 'spo2', load)).toEqual(WM)
    expect(await cache.get('ziva', 'fam1', 'spo2', load)).toEqual(WM)

    expect(load).toHaveBeenCalledTimes(1)
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 })
  })

  it('keys per (brand, familyId, table) — no cross-tenant bleed', async () => {
    const cache = createWatermarkCache({ enabled: true })
    const load = vi.fn(async () => WM)

    await cache.get('ziva', 'fam1', 'spo2', load)
    await cache.get('viva', 'fam1', 'spo2', load) // different brand
    await cache.get('ziva', 'fam2', 'spo2', load) // different family
    await cache.get('ziva', 'fam1', 'hrv', load) // different table

    expect(load).toHaveBeenCalledTimes(4)
    expect(cache.stats().hits).toBe(0)
  })

  it('expires after the TTL', async () => {
    let clock = 1_000
    const cache = createWatermarkCache({ enabled: true, now: () => clock })
    const load = vi.fn(async () => WM)

    await cache.get('ziva', 'fam1', 'spo2', load)
    clock += WATERMARK_CACHE_TTL_MS - 1
    await cache.get('ziva', 'fam1', 'spo2', load)
    expect(load).toHaveBeenCalledTimes(1)

    clock += 2 // now past the TTL
    await cache.get('ziva', 'fam1', 'spo2', load)
    expect(load).toHaveBeenCalledTimes(2)
    expect(cache.stats().expirations).toBe(1)
  })

  it('caches a null watermark — "nothing pushed" is a real answer', async () => {
    // A fresh install has no watermark row; re-querying it on every scan
    // is the exact cost the cache exists to remove.
    const cache = createWatermarkCache({ enabled: true })
    const load = vi.fn(async () => null)

    expect(await cache.get('ziva', 'fam1', 'spo2', load)).toBeNull()
    expect(await cache.get('ziva', 'fam1', 'spo2', load)).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe('invalidation', () => {
  it('drops a table on {table}:sync_complete', async () => {
    const { bus } = fakeBus()
    const cache = createWatermarkCache({ enabled: true, eventBus: bus })
    const load = vi.fn(async () => WM)

    await cache.get('ziva', 'fam1', 'spo2', load)
    bus.emit('spo2:sync_complete', {})
    await cache.get('ziva', 'fam1', 'spo2', load)

    // A push advanced the watermark, so the cached value is wrong and must
    // not be served.
    expect(load).toHaveBeenCalledTimes(2)
    expect(cache.stats().invalidations).toBe(1)
  })

  it('invalidates that table across every tenant', async () => {
    const { bus } = fakeBus()
    const cache = createWatermarkCache({ enabled: true, eventBus: bus })
    const load = vi.fn(async () => WM)

    await cache.get('ziva', 'fam1', 'spo2', load)
    await cache.get('ziva', 'fam2', 'spo2', load)
    bus.emit('spo2:sync_complete', {})

    await cache.get('ziva', 'fam1', 'spo2', load)
    await cache.get('ziva', 'fam2', 'spo2', load)
    expect(load).toHaveBeenCalledTimes(4)
  })

  it('leaves other tables alone', async () => {
    const { bus } = fakeBus()
    const cache = createWatermarkCache({ enabled: true, eventBus: bus })
    const load = vi.fn(async () => WM)

    await cache.get('ziva', 'fam1', 'spo2', load)
    await cache.get('ziva', 'fam1', 'hrv', load)
    bus.emit('spo2:sync_complete', {})

    await cache.get('ziva', 'fam1', 'hrv', load)
    expect(load).toHaveBeenCalledTimes(2) // hrv still cached
  })

  it('subscribes even when disabled, so a runtime flip is safe', async () => {
    // Otherwise enabling the gate would inherit a cache that silently
    // missed every invalidation while it was off.
    const { bus, patternCount } = fakeBus()
    createWatermarkCache({ enabled: false, eventBus: bus })
    expect(patternCount()).toBe(1)
  })

  it('clear() drops everything — used on attach + brand switch', async () => {
    const cache = createWatermarkCache({ enabled: true })
    const load = vi.fn(async () => WM)

    await cache.get('ziva', 'fam1', 'spo2', load)
    cache.clear()
    await cache.get('ziva', 'fam1', 'spo2', load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('dispose() unsubscribes from the bus', async () => {
    const { bus, patternCount } = fakeBus()
    const cache = createWatermarkCache({ enabled: true, eventBus: bus })
    expect(patternCount()).toBe(1)
    cache.dispose()
    expect(patternCount()).toBe(0)
  })
})

describe('instrumentation', () => {
  it('reports p50/p95/p99 over observed loader latencies', async () => {
    let clock = 0
    const cache = createWatermarkCache({ now: () => clock })

    for (const ms of [1, 2, 3, 4, 100]) {
      await cache.get('ziva', 'fam1', `t${ms}`, async () => {
        clock += ms
        return WM
      })
    }

    const { latency } = cache.stats()
    expect(latency.samples).toBe(5)
    expect(latency.p50).toBe(3)
    expect(latency.p99).toBe(100)
  })

  it('returns zeroes rather than NaN with no samples', () => {
    expect(createWatermarkCache().stats().latency).toEqual({
      p50: 0, p95: 0, p99: 0, samples: 0,
    })
  })
})
