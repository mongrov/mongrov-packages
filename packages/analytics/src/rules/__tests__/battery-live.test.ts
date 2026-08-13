/**
 * Live-engine battery rules test (0.6.0 fix B2 acceptance).
 *
 * The pre-0.6.0 `device_battery` metric compiled to
 * `arg_max(payload, ts) < 15` against `device_event.payload` — a JSON
 * VARCHAR with no `event_type` filter — so the LuminX battery rules ran
 * without error but could never fire correctly against real data. The
 * bug survived because rules tests used mocked engines returning numeric
 * values directly.
 *
 * This suite closes that hole: a REAL DuckDB (@duckdb/node-api, local
 * mode, no extensions → no network) runs the production `createAnalytics`
 * factory + `createRulesEngine` with the shipped LuminX defaults, plants
 * battery rows in `device_battery`, and asserts actual fires.
 */

import type { AnalyticsEngine } from '../../core/types'

import type { RulesEngine } from '../index'
import { describe, expect, it } from 'vitest'
import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { createAnalytics } from '../../core/factory'

import { luminxDefaults } from '../defaults'
import { createRulesEngine } from '../index'

const BRAND = 'luminx'
const USER = 'user_asset_1'

async function bootLive(): Promise<{
  analytics: AnalyticsEngine
  rules: RulesEngine
}> {
  const { kv } = createFakeKV()
  const analytics = createAnalytics(
    {
      mode: 'local',
      storage: kv,
      retention: {},
    },
    // Local mode loads no extensions — pass [] so the test never
    // touches the DuckDB extension repository.
    { duckdbFactory: () => createRealDuckDB([]) },
  )
  await new Promise<void>((resolve, reject) => {
    const t = setInterval(() => {
      if (analytics.state === 'ready') { clearInterval(t); resolve() }
      if (analytics.lastError) { clearInterval(t); reject(analytics.lastError) }
    }, 10)
  })
  await analytics.attach({
    brand: BRAND,
    tenantScope: 'org',
    tenantId: USER,
    userId: USER,
  })

  const rules = createRulesEngine({
    analytics,
    storage: kv,
    familyMembersProvider: async () => [USER],
    brand: BRAND,
    familyId: USER,
  })
  await rules.register([...luminxDefaults])
  return { analytics, rules }
}

async function insertBattery(
  analytics: AnalyticsEngine,
  pct: number,
  minutesAgo: number,
): Promise<void> {
  await analytics.execute(
    `INSERT INTO device_battery (ts, brand, family_id, user_id, device_id, battery_pct)
     VALUES (NOW() - (INTERVAL 1 MINUTE) * $mins, $brand, $fam, $u, $d, $pct)`,
    { mins: minutesAgo, brand: BRAND, fam: USER, u: USER, d: 'asset_tag_7', pct },
  )
}

describe('LuminX battery rules against a live local engine', () => {
  it('battery-low fires on a planted 8% sample; battery-critical does not', async () => {
    const { analytics, rules } = await bootLive()
    try {
      await insertBattery(analytics, 8, 5)

      const violations = await rules.evaluateScheduled()
      const ids = violations.map(v => v.ruleId).sort()

      // 8 < 15 → battery-low fires. 8 > 5 → battery-critical silent.
      // count over 24h = 1 ≠ 0 → disconnect-24h silent.
      expect(ids).toEqual(['luminx.battery-low'])
      const low = violations[0]
      expect(low.observedValue).toBe(8)
      expect(low.thresholdValue).toBe(15)
    }
    finally {
      await analytics.close()
    }
  })

  it('battery-critical + battery-low both fire at 3%', async () => {
    const { analytics, rules } = await bootLive()
    try {
      await insertBattery(analytics, 3, 5)

      const violations = await rules.evaluateScheduled()
      const ids = violations.map(v => v.ruleId).sort()

      expect(ids).toEqual(['luminx.battery-critical', 'luminx.battery-low'])
    }
    finally {
      await analytics.close()
    }
  })

  it('disconnect-24h fires when no battery rows exist in the window', async () => {
    const { analytics, rules } = await bootLive()
    try {
      // No rows planted at all → COUNT(battery_pct) over 24h = 0.
      const violations = await rules.evaluateScheduled()
      const ids = violations.map(v => v.ruleId)

      expect(ids).toEqual(['luminx.disconnect-24h'])
    }
    finally {
      await analytics.close()
    }
  })

  it('healthy battery (80%) in-window produces zero violations', async () => {
    const { analytics, rules } = await bootLive()
    try {
      await insertBattery(analytics, 80, 5)

      const violations = await rules.evaluateScheduled()

      expect(violations).toEqual([])
    }
    finally {
      await analytics.close()
    }
  })

  it('stale sample outside the 1h window does not satisfy battery-low but counts for disconnect', async () => {
    const { analytics, rules } = await bootLive()
    try {
      // 90 minutes ago: outside battery-low's 1h window, inside
      // disconnect-24h's 24h window.
      await insertBattery(analytics, 8, 90)

      const violations = await rules.evaluateScheduled()

      // battery-low's window has no rows → arg_max over empty set is
      // NULL → HAVING NULL < 15 is not true → no fire. disconnect sees
      // count=1 ≠ 0 → no fire.
      expect(violations).toEqual([])
    }
    finally {
      await analytics.close()
    }
  })
})
