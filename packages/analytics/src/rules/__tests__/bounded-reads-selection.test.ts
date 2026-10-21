/*
 * Which form of a rule runs (mongrov-packages#44).
 *
 * A compiled rule on a vital carries two statements: `sql` over the
 * full-history views and `boundedSql` over the `_between` macros. The
 * evaluator runs the bounded one only when the engine reports every macro
 * present (`boundedReads`); otherwise the views, which always exist. A macro
 * missing at attach must cost speed, never a rule.
 * `bounded-readers-equivalence.test.ts` proves the two forms agree.
 */
import type { Rule } from '../schema'
import { describe, expect, it, vi } from 'vitest'
import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { createAnalytics } from '../../core/factory'
import { createFakeClock } from '../__fakes__/fakeClock'
import { createFakeEngine } from '../__fakes__/fakeEngine'
import { createFakeStorage } from '../__fakes__/fakeStorage'
import { compileRule } from '../compiler'
import { createCompilerCache } from '../compiler-cache'
import { createEmitter } from '../emitter'
import { createEvaluator } from '../evaluator'
import { createRulesRegistry } from '../registry'
import { createThrottleStore } from '../throttle'

const spo2Rule = {
  id: 'test.spo2.low',
  name: 'SpO2 low',
  metric: 'spo2',
  window: '24h',
  aggregation: 'avg',
  compare: 'less_than',
  context: 'resting',
  severity: 'warn',
  target: { type: 'absolute', value: 40 },
} as const satisfies Partial<Rule> as Rule

async function evaluatedSql(boundedReads: boolean | undefined): Promise<string> {
  const storage = createFakeStorage()
  const clock = createFakeClock('2025-01-01T00:00:00Z')
  const analytics = createFakeEngine()
  if (boundedReads !== undefined)
    Object.defineProperty(analytics, 'boundedReads', { value: boundedReads })
  const registry = createRulesRegistry({ storage })
  await registry.register([spo2Rule])
  const evaluator = createEvaluator({
    registry,
    cache: createCompilerCache(),
    throttle: createThrottleStore({ storage, clock }),
    emitter: createEmitter(),
    analytics,
    brand: 'ziva',
    familyId: 'fam1',
    familyMembersProvider: vi.fn(async () => ['u1']),
    clock,
  })
  analytics.__setResult([])
  await evaluator.evaluateOnBatch({ affectedUserIds: ['u1'], affectedTables: ['spo2'] })
  expect(analytics.__calls).toHaveLength(1)
  return analytics.__calls[0]!.sql
}

describe('bounded rule reads', () => {
  it('compiles a bounded form for a vital, and none for a plain table', () => {
    const c = compileRule(spo2Rule)
    expect(c.sql).toContain('FROM v_spo2_clean m')
    expect(c.sql).toContain('INNER JOIN v_spo2_q rq')
    expect(c.boundedSql).toContain(`FROM v_spo2_clean_between(timezone('UTC', now()) - (INTERVAL 1 HOUR) * CAST(48 AS BIGINT), timezone('UTC', now()) + INTERVAL 32 DAY) m`)
    expect(c.boundedSql).toContain(`INNER JOIN v_spo2_q_between(timezone('UTC', now()) - (INTERVAL 1 HOUR) * CAST(48 AS BIGINT)`)
    // Nothing else changes: strip the bounds and the two are the same text.
    expect(c.boundedSql!.replace(/_between\(timezone\('UTC', now\(\)\) - .*?INTERVAL 32 DAY\)/g, '')).toBe(c.sql)

    const battery = compileRule({ ...spo2Rule, id: 'b', metric: 'device_battery', context: 'any', window: '1h' } as Rule)
    expect(battery.boundedSql).toBeUndefined()
  })

  it('runs the bounded form only when the engine reports every macro present', async () => {
    expect(await evaluatedSql(true)).toContain('v_spo2_clean_between(')
    expect(await evaluatedSql(false)).not.toContain('_between(')
    // An engine that does not report the capability gets the views.
    expect(await evaluatedSql(undefined)).not.toContain('_between(')
  })

  it('a real engine reports boundedReads while attached, and not after detach', async () => {
    const { kv } = createFakeKV()
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
    expect(analytics.boundedReads).toBe(false)
    await analytics.attach({ brand: 'ziva', tenantScope: 'family', tenantId: 'u1', userId: 'u1' })
    expect(analytics.boundedReads).toBe(true)
    // And the bounded statement actually executes on it.
    const c = compileRule(spo2Rule)
    await expect(analytics.execute(c.boundedSql!, { userId: 'u1', brand: 'ziva', familyId: 'u1', threshold_absolute: 40 }))
      .resolves
      .toEqual([])
    await analytics.detach()
    expect(analytics.boundedReads).toBe(false)
    await analytics.close()
  }, 60_000)
})
