import { describe, expect, it, vi } from 'vitest'
import { createRulesEngine } from '../factory'
import { createFakeEngine } from '../__fakes__/fakeEngine'
import { createFakeStorage } from '../__fakes__/fakeStorage'
import { createFakeClock } from '../__fakes__/fakeClock'
import type { Rule } from '../schema'

const rule = {
  id: 'test.hrv.drop',
  name: 'HRV drop',
  metric: 'hrv_ms',
  window: '24h',
  aggregation: 'avg',
  compare: 'less_than',
  severity: 'warn',
  target: { type: 'absolute', value: 40 },
} as const satisfies Partial<Rule> as Rule

function build() {
  const storage = createFakeStorage()
  const analytics = createFakeEngine()
  const clock = createFakeClock('2025-01-01T00:00:00Z')
  const engine = createRulesEngine({
    analytics,
    storage,
    brand: 'ziva',
    familyId: 'fam1',
    familyMembersProvider: async () => ['u1'],
    clock,
  })
  return { storage, analytics, clock, engine }
}

describe('createRulesEngine', () => {
  it('end-to-end register → evaluate → emit', async () => {
    const { engine, analytics } = build()
    await engine.register([rule])
    analytics.__setResult([{ observed_value: 20, threshold_value: 40 }])
    const seen: unknown[] = []
    const unsub = engine.on('violation', v => seen.push(v))
    const violations = await engine.evaluateOnBatch({
      affectedUserIds: ['u1'],
      affectedTables: ['hrv'],
    })
    expect(violations).toHaveLength(1)
    expect(seen).toHaveLength(1)
    unsub()
  })

  it('list + getActive reflect disable', async () => {
    const { engine } = build()
    await engine.register([rule])
    expect(engine.list()).toHaveLength(1)
    expect(engine.getActive()).toHaveLength(1)
    await engine.disable(rule.id)
    expect(engine.list()).toHaveLength(1)
    expect(engine.getActive()).toHaveLength(0)
    await engine.enable(rule.id)
    expect(engine.getActive()).toHaveLength(1)
  })

  it('subscribeRegistry fires on register + enable/disable', async () => {
    const { engine } = build()
    const listener = vi.fn()
    const unsub = engine.subscribeRegistry(listener)
    await engine.register([rule])
    await engine.disable(rule.id)
    unsub()
    await engine.enable(rule.id) // should NOT fire after unsub
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('evaluateScheduled fans out over familyMembersProvider', async () => {
    const { engine, analytics } = build()
    await engine.register([rule])
    analytics.__setResult([])
    await engine.evaluateScheduled()
    expect(analytics.__calls.length).toBe(1) // one member
  })

  it('brand defaultBrand default is config.brand', async () => {
    const { engine, analytics } = build()
    // Register a rule with a different brand — should be excluded from
    // getByBrand('ziva') filtering inside evaluator.
    await engine.register([
      { ...rule, id: 'off.brand', brand: 'other' },
      rule, // ziva default
    ])
    analytics.__setResult([])
    await engine.evaluateOnBatch({
      affectedUserIds: ['u1'],
      affectedTables: ['hrv'],
    })
    // Only the ziva rule ran.
    expect(analytics.__calls).toHaveLength(1)
  })
})
