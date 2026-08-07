/**
 * Sprint 5 T-41 — effective sampling cadence (principle 22).
 *
 * The behaviour that matters: a firmware upgrade that changes sampling rate
 * must propagate to charts and rules with no app release, and an install
 * that has never synced must still get a sensible number.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  createSamplingResolver,
  fallbackSampling,
  minimumWindowMinutes,
  SAMPLING_CACHE_TTL_MS,
} from '../sampling'

/** Engine stub returning a scripted device_config row. */
function engineWith(intervalMinutes: number | null | undefined) {
  const calls: { sql: string, params: Record<string, unknown> }[] = []
  return {
    calls,
    analytics: {
      async execute(sql: string, params?: Record<string, unknown>) {
        calls.push({ sql, params: params ?? {} })
        return intervalMinutes === undefined
          ? []
          : [{ interval_minutes: intervalMinutes }]
      },
    },
  }
}

describe('fallback', () => {
  it('uses metric_metadata when the device has no config row', async () => {
    const { analytics } = engineWith(undefined)
    const r = createSamplingResolver({ analytics: analytics as never })

    // Pre-first-sync is the normal state for a fresh install.
    expect(await r.resolve('spo2', 'ring_1')).toEqual({
      minutes: 30,
      source: 'metric_metadata',
    })
  })

  it('skips the query entirely with no deviceId', async () => {
    // Register-time validation has no device context. Permissive by
    // design: a denser real device only makes a rule MORE satisfiable.
    const { analytics, calls } = engineWith(5)
    const r = createSamplingResolver({ analytics: analytics as never })

    expect(await r.resolve('spo2')).toEqual({
      minutes: 30,
      source: 'metric_metadata',
    })
    expect(calls).toHaveLength(0)
  })

  it('fallbackSampling needs no engine at all', () => {
    expect(fallbackSampling('hrv_ms')).toEqual({
      minutes: 60,
      source: 'metric_metadata',
    })
    expect(fallbackSampling('sleep_total_minutes').minutes).toBe('per_session')
  })
})

describe('device_config override', () => {
  it('prefers the device cadence over the metadata default', async () => {
    // The principle-22 case: next-gen ring samples SpO2 every 5 minutes
    // instead of 30, and existing installs get denser charts with no
    // app update.
    const { analytics } = engineWith(5)
    const r = createSamplingResolver({ analytics: analytics as never })

    expect(await r.resolve('spo2', 'ring_next_gen')).toEqual({
      minutes: 5,
      source: 'device_config',
    })
  })

  it('queries the open row for that device + metric, newest first', async () => {
    const { analytics, calls } = engineWith(5)
    const r = createSamplingResolver({ analytics: analytics as never })
    await r.resolve('spo2', 'ring_1')

    const { sql, params } = calls[0]
    expect(sql).toContain('FROM device_config')
    expect(sql).toContain('valid_to IS NULL')       // SCD-2: current row only
    expect(sql).toContain('ORDER BY valid_from DESC')
    expect(params).toEqual({ deviceId: 'ring_1', metric: 'spo2' })
  })

  it('ignores a nonsensical interval', async () => {
    for (const bad of [0, -5, null]) {
      const { analytics } = engineWith(bad as number | null)
      const r = createSamplingResolver({ analytics: analytics as never })
      expect((await r.resolve('spo2', 'ring_1')).source).toBe('metric_metadata')
    }
  })

  it('falls back and logs rather than failing the caller', async () => {
    // A cadence lookup must not be able to fail a chart render.
    const warn = vi.fn()
    const analytics = {
      async execute() { throw new Error('device_config missing') },
    }
    const r = createSamplingResolver({
      analytics: analytics as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    })

    expect((await r.resolve('spo2', 'ring_1')).source).toBe('metric_metadata')
    expect(warn).toHaveBeenCalled()
  })
})

describe('memoization', () => {
  it('caches per (deviceId, metric)', async () => {
    const { analytics, calls } = engineWith(5)
    const r = createSamplingResolver({ analytics: analytics as never })

    await r.resolve('spo2', 'ring_1')
    await r.resolve('spo2', 'ring_1')
    expect(calls).toHaveLength(1)

    await r.resolve('hrv_ms', 'ring_1')   // different metric
    await r.resolve('spo2', 'ring_2')     // different device
    expect(calls).toHaveLength(3)
  })

  it('expires after the TTL', async () => {
    let t = 0
    const { analytics, calls } = engineWith(5)
    const r = createSamplingResolver({ analytics: analytics as never, now: () => t })

    await r.resolve('spo2', 'ring_1')
    t += SAMPLING_CACHE_TTL_MS - 1
    await r.resolve('spo2', 'ring_1')
    expect(calls).toHaveLength(1)

    t += 2
    await r.resolve('spo2', 'ring_1')
    expect(calls).toHaveLength(2)
  })

  it('invalidate(deviceId) drops only that device', async () => {
    // A sync that wrote a new config row should not blow away every
    // other device's memo.
    const { analytics, calls } = engineWith(5)
    const r = createSamplingResolver({ analytics: analytics as never })

    await r.resolve('spo2', 'ring_1')
    await r.resolve('spo2', 'ring_2')
    r.invalidate('ring_1')

    await r.resolve('spo2', 'ring_1')   // re-queried
    await r.resolve('spo2', 'ring_2')   // still cached
    expect(calls).toHaveLength(3)
  })

  it('invalidate() with no argument clears everything', async () => {
    const { analytics, calls } = engineWith(5)
    const r = createSamplingResolver({ analytics: analytics as never })

    await r.resolve('spo2', 'ring_1')
    r.invalidate()
    await r.resolve('spo2', 'ring_1')
    expect(calls).toHaveLength(2)
  })
})

describe('minimumWindowMinutes', () => {
  it('scales the window with consecutive count', () => {
    expect(minimumWindowMinutes(30, 3)).toBe(90)
    expect(minimumWindowMinutes(5, 3)).toBe(15)   // denser device needs less
  })

  it('treats consecutive < 1 as 1', () => {
    expect(minimumWindowMinutes(30, 0)).toBe(30)
  })

  it('returns null for per-session metrics', () => {
    // "3 consecutive nights" is bounded by the rule's window in days, not
    // by a sampling interval.
    expect(minimumWindowMinutes('per_session', 3)).toBeNull()
  })
})
