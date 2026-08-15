import type { Rule } from '../schema'
import { describe, expect, it, vi } from 'vitest'
import { createFakeClock } from '../__fakes__/fakeClock'
import { createFakeEngine } from '../__fakes__/fakeEngine'
import { createFakeStorage } from '../__fakes__/fakeStorage'
import { createRulesEngine } from '../factory'

const rule = {
  id: 'test.hrv.drop',
  name: 'HRV drop',
  metric: 'spo2',
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
      affectedTables: ['spo2'],
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
      affectedTables: ['spo2'],
    })
    // Only the ziva rule ran.
    expect(analytics.__calls).toHaveLength(1)
  })

  it('evaluateScheduled throws not_attached when analytics state !== attached', async () => {
    const { engine, analytics } = build()
    await engine.register([rule])
    analytics.__setState('ready')
    await expect(engine.evaluateScheduled()).rejects.toMatchObject({
      code: 'not_attached',
      message: expect.stringContaining('evaluateScheduled requires an attached analytics engine'),
    })
    analytics.__setState('attaching')
    await expect(engine.evaluateScheduled()).rejects.toMatchObject({
      code: 'not_attached',
    })
  })

  it('replace() swaps rule set atomically via registry', async () => {
    const { engine, analytics } = build()
    await engine.register([rule])
    // New rule targets a different table (heart_rate) so we can prove the
    // old (hrv-table) rule is gone by driving evaluateOnBatch with each
    // table separately.
    const other = {
      ...rule,
      id: 'test.hr.spike',
      metric: 'hr_bpm',
      compare: 'greater_than',
      target: { type: 'absolute', value: 120 },
    } as const satisfies Partial<Rule> as Rule
    await engine.replace([other])
    expect(engine.list()).toHaveLength(1)
    expect(engine.list()[0].id).toBe('test.hr.spike')

    // hrv table — old rule was here, but replace() removed it: no fire.
    analytics.__setResult([{ observed_value: 10, threshold_value: 40 }])
    const hrvViolations = await engine.evaluateOnBatch({
      affectedUserIds: ['u1'],
      affectedTables: ['spo2'],
    })
    expect(hrvViolations).toHaveLength(0)

    // heart_rate table — new rule matches, fires.
    analytics.__setResult([{ observed_value: 150, threshold_value: 120 }])
    const hrViolations = await engine.evaluateOnBatch({
      affectedUserIds: ['u1'],
      affectedTables: ['heart_rate'],
    })
    expect(hrViolations).toHaveLength(1)
  })

  it('close() clears violation handlers; subsequent evaluate returns []', async () => {
    const { engine, analytics } = build()
    await engine.register([rule])
    const seen: unknown[] = []
    engine.on('violation', v => seen.push(v))

    await engine.close()

    analytics.__setResult([{ observed_value: 10, threshold_value: 40 }])
    const violations = await engine.evaluateOnBatch({
      affectedUserIds: ['u1'],
      affectedTables: ['spo2'],
    })
    expect(violations).toEqual([])
    expect(seen).toEqual([])
  })

  it('close() is idempotent', async () => {
    const { engine } = build()
    await engine.close()
    await expect(engine.close()).resolves.toBeUndefined()
  })

  it('after close(), on() returns a no-op unsub and never fires', async () => {
    const { engine } = build()
    await engine.close()
    const unsub = engine.on('violation', () => {
      throw new Error('should not fire')
    })
    expect(typeof unsub).toBe('function')
    unsub()
  })
})
