/**
 * Live-engine rules → insight pipeline test (fix RU-1 acceptance).
 *
 * Pre-0.7.0, violations only reached the engine's private emitter — zero
 * INSERTs into `insight` existed anywhere in src/rules, so the registry
 * contract (worthALookInsight) and the app bus (`threshold:violation`,
 * `insight:insert`) could never see a rule fire. This suite runs a REAL
 * DuckDB (local mode) through the production factories and asserts the
 * violation lands as a queryable `insight` row with the spec columns.
 */

import type { AnalyticsEngine, EventBus } from '../../core/types'

import type { RulesEngine } from '../index'
import { describe, expect, it, vi } from 'vitest'
import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { createAnalytics } from '../../core/factory'

import { luminxDefaults } from '../defaults'
import { createRulesEngine } from '../index'

const BRAND = 'luminx'
const USER = 'user_asset_1'

interface MockBus extends EventBus {
  emit: ReturnType<typeof vi.fn>
}

function makeBus(): MockBus {
  return {
    emit: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribePattern: vi.fn(() => () => {}),
  } as unknown as MockBus
}

async function bootLive(eventBus?: EventBus): Promise<{
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
    eventBus,
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

interface InsightRow {
  insight_id: string
  brand: string
  family_id: string
  user_id: string
  rule_id: string
  metric: string
  kind: string
  severity: string
  title: string
  body: string | null
  evidence: string
  dismissed_at: unknown
}

describe('rules → insight table + app bus against a live local engine', () => {
  it('a fired rule writes a spec-shaped insight row (critical maps to urgent)', async () => {
    const { analytics, rules } = await bootLive()
    try {
      await insertBattery(analytics, 3, 5)

      const violations = await rules.evaluateScheduled()
      expect(violations.map(v => v.ruleId).sort())
        .toEqual(['luminx.battery-critical', 'luminx.battery-low'])

      const rows = await analytics.execute<InsightRow>(
        `SELECT * FROM insight ORDER BY rule_id`,
      )
      expect(rows).toHaveLength(2)

      const critical = rows.find(r => r.rule_id === 'luminx.battery-critical')!
      expect(critical.insight_id).toHaveLength(24)
      expect(critical.kind).toBe('threshold')
      expect(critical.metric).toBe('device_battery')
      expect(critical.severity).toBe('urgent') // rule 'critical' → insight 'urgent'
      expect(critical.brand).toBe(BRAND)
      expect(critical.family_id).toBe(USER)
      expect(critical.user_id).toBe(USER)
      expect(critical.title.length).toBeGreaterThan(0)
      expect(critical.dismissed_at).toBeNull()
      const evidence = JSON.parse(critical.evidence)
      expect(evidence).toMatchObject({
        metric: 'device_battery',
        observedValue: 3,
      })

      const low = rows.find(r => r.rule_id === 'luminx.battery-low')!
      expect(low.severity).toBe('warn')
    }
    finally {
      await analytics.close()
    }
  })

  it('rows are visible through the registry-contract filter (dismissed_at IS NULL)', async () => {
    const { analytics, rules } = await bootLive()
    try {
      await insertBattery(analytics, 8, 5)
      await rules.evaluateScheduled()

      const rows = await analytics.execute<{ insight_id: string, metric: string }>(
        `SELECT insight_id, metric, title, body, severity, ts
         FROM insight
         WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
           AND metric = 'device_battery'
           AND dismissed_at IS NULL
         ORDER BY ts DESC`,
        { userId: USER, brand: BRAND, familyId: USER },
      )
      expect(rows).toHaveLength(1)
    }
    finally {
      await analytics.close()
    }
  })

  it('emits threshold:violation + insight:insert on the app bus, keeps the private emitter', async () => {
    const bus = makeBus()
    const { analytics, rules } = await bootLive(bus)
    try {
      const privateListener = vi.fn()
      rules.on('violation', privateListener)
      await insertBattery(analytics, 8, 5)

      await rules.evaluateScheduled()

      expect(privateListener).toHaveBeenCalledOnce() // useRuleViolations path intact
      const events = bus.emit.mock.calls
      const violationEvt = events.find(([name]) => name === 'threshold:violation')
      const insertEvt = events.find(([name]) => name === 'insight:insert')
      expect(violationEvt?.[1]).toMatchObject({
        ruleId: 'luminx.battery-low',
        userId: USER,
        metric: 'device_battery',
        severity: 'warn',
        observedValue: 8,
        thresholdValue: 15,
      })
      const insightId = (violationEvt?.[1] as { insightId: string }).insightId
      expect(insertEvt?.[1]).toEqual({
        insightId,
        userId: USER,
        metric: 'device_battery',
      })

      // The bus insightId points at the persisted row.
      const rows = await analytics.execute<{ insight_id: string }>(
        `SELECT insight_id FROM insight WHERE insight_id = $id`,
        { id: insightId },
      )
      expect(rows).toHaveLength(1)
    }
    finally {
      await analytics.close()
    }
  })
})
