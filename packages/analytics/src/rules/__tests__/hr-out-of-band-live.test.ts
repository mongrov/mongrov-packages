/**
 * `ziva.hr-out-of-band` (D-H, zivaone_app T-26) on a live engine: the
 * behaviours the catalog shape cannot show.
 *
 * `ziva-defaults-live.test.ts` proves the shipped rule fires once and is
 * throttled. This proves WHAT it fires on: either side of the band, only
 * asleep, only after a run, against the user's stored band once it exists,
 * and against the band their sensitivity setting draws.
 *
 * Population rails 48-62: midpoint 55, half-width 7. Normal keeps 48-62,
 * watchful (0.7) narrows to 50.1-59.9, gentle (1.35) widens to 45.55-64.45.
 */

import type { AnalyticsEngine, EventBus } from '../../core/types'
import { describe, expect, it, vi } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { createAnalytics } from '../../core/factory'
import { zivaDefaults } from '../defaults'
import { createRulesEngine } from '../index'

const BRAND = 'ziva'
const USER = 'user_1'
const DEVICE = 'ring_1'
const RULE = 'ziva.hr-out-of-band'
const ids = { brand: BRAND, fam: USER, u: USER, d: DEVICE }

async function boot(sensitivity?: string) {
  const { kv } = createFakeKV()
  if (sensitivity !== undefined)
    await kv.set(`analytics:${USER}:user:hrSensitivity`, sensitivity)
  const analytics = createAnalytics(
    { mode: 'local', storage: kv, retention: {} },
    { duckdbFactory: () => createRealDuckDB(['icu']) },
  )
  await new Promise<void>((resolve, reject) => {
    const t = setInterval(() => {
      if (analytics.state === 'ready') { clearInterval(t); resolve() }
      if (analytics.lastError) { clearInterval(t); reject(analytics.lastError) }
    }, 10)
  })
  await analytics.attach({ brand: BRAND, tenantScope: 'family', tenantId: USER, userId: USER })
  const bus = { emit: vi.fn(), subscribe: vi.fn(() => () => {}), subscribePattern: vi.fn(() => () => {}) }
  const rules = createRulesEngine({
    analytics,
    storage: kv,
    familyMembersProvider: async () => [USER],
    brand: BRAND,
    familyId: USER,
    eventBus: bus as unknown as EventBus,
    userTimezoneProvider: async () => 'UTC',
  })
  await rules.register(zivaDefaults.filter(r => r.id === RULE))
  return { analytics, rules }
}

async function night(a: AnalyticsEngine) {
  await a.execute(
    `INSERT INTO sleep_session (session_id, ts_start, ts_end, brand, family_id, user_id, device_id, total_minutes, night_of)
     VALUES ('s', CAST(NOW() AS TIMESTAMP) - INTERVAL 8 HOUR, CAST(NOW() AS TIMESTAMP) - INTERVAL 1 HOUR,
             $brand, $fam, $u, $d, 420, CAST(CAST(NOW() AS TIMESTAMP) - INTERVAL 8 HOUR AS DATE))`,
    ids,
  )
}

/**
 * A reading every 10 minutes from 7h to 5 minutes ago (the night spans 8h-1h
 * ago), `run` for readings `from..to` minutes ago and `rest` otherwise.
 */
async function readings(a: AnalyticsEngine, rest: number, run: number, from = 120, to = 145) {
  for (let m = 5; m <= 7 * 60; m += 10) {
    await a.execute(
      `INSERT INTO heart_rate (ts, brand, family_id, user_id, device_id, bpm)
       VALUES (CAST(NOW() AS TIMESTAMP) - (INTERVAL 1 MINUTE) * CAST($m AS BIGINT), $brand, $fam, $u, $d, $v)`,
      { ...ids, m, v: m >= from && m <= to ? run : rest },
    )
  }
}

async function storedBand(a: AnalyticsEngine, lo: number | null, hi: number | null) {
  for (const [metric, v] of [['hr_asleep_lo', lo], ['hr_asleep_hi', hi]] as const) {
    if (v === null)
      continue
    await a.execute(
      `INSERT INTO user_baseline (brand, family_id, user_id, metric, window_days, p05, p10, p50, p90, p95, mean, stddev, sample_count, computed_at)
       VALUES ($brand, $fam, $u, $metric, 90, $v, $v, $v, $v, $v, $v, 1, 30, NOW())`,
      { brand: BRAND, fam: USER, u: USER, metric, v },
    )
  }
}

async function fires(opts: { rest: number, run: number, from?: number, to?: number, sensitivity?: string, band?: [number | null, number | null], asleep?: boolean }) {
  const { analytics, rules } = await boot(opts.sensitivity)
  try {
    if (opts.asleep !== false)
      await night(analytics)
    if (opts.band)
      await storedBand(analytics, opts.band[0], opts.band[1])
    await readings(analytics, opts.rest, opts.run, opts.from, opts.to)
    const v = await rules.evaluateScheduled()
    return v.find(x => x.ruleId === RULE) ?? null
  }
  finally {
    await analytics.close()
  }
}

describe('ziva.hr-out-of-band on a live engine', () => {
  it('fires ABOVE the band, quoting the worst reading and the rail it crossed', async () => {
    const v = await fires({ rest: 55, run: 70 })
    expect(v).not.toBeNull()
    expect(v!.observedValue).toBe(70)
    expect(v!.thresholdValue).toBeCloseTo(62, 5)
  }, 60_000)

  it('fires BELOW the band too — the band is two-sided', async () => {
    const v = await fires({ rest: 55, run: 40 })
    expect(v).not.toBeNull()
    expect(v!.observedValue).toBe(40)
    expect(v!.thresholdValue).toBeCloseTo(48, 5)
  }, 60_000)

  it('needs a run: two readings outside are not half an hour', async () => {
    await expect(fires({ rest: 55, run: 70, from: 120, to: 135 })).resolves.toBeNull()
  }, 60_000)

  it('watches sleep only: the same readings awake do not fire', async () => {
    await expect(fires({ rest: 55, run: 70, asleep: false })).resolves.toBeNull()
  }, 60_000)

  it('uses the stored band once learned, not the population rails', async () => {
    // 60 is inside 48-62, but outside a learned 50-58.
    await expect(fires({ rest: 54, run: 60 })).resolves.toBeNull()
    await expect(fires({ rest: 54, run: 60, band: [50, 58] })).resolves.not.toBeNull()
  }, 60_000)

  it('treats half a stored band as no band: the population rails still apply', async () => {
    // A lone stored low rail of 58, mixed with the default high, would make a
    // 58-62 band and flag this whole in-band night of 54s.
    await expect(fires({ rest: 54, run: 54, band: [58, null] })).resolves.toBeNull()
  }, 60_000)

  it('follows the sensitivity: watchful narrows the band, gentle widens it', async () => {
    // 61 is inside normal (48-62) but outside watchful (50.1-59.9).
    await expect(fires({ rest: 55, run: 61 })).resolves.toBeNull()
    await expect(fires({ rest: 55, run: 61, sensitivity: 'watchful' })).resolves.not.toBeNull()
    // 63 is outside normal, inside gentle (45.55-64.45).
    await expect(fires({ rest: 55, run: 63 })).resolves.not.toBeNull()
    await expect(fires({ rest: 55, run: 63, sensitivity: 'gentle' })).resolves.toBeNull()
  }, 120_000)

  it('an unknown sensitivity falls back to normal rather than going quiet', async () => {
    await expect(fires({ rest: 55, run: 63, sensitivity: 'loud' })).resolves.not.toBeNull()
  }, 60_000)
})
