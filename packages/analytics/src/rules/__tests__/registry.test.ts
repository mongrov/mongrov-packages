import { describe, expect, it } from 'vitest'
import { createRulesRegistry } from '../registry'
import { createFakeStorage } from '../__fakes__/fakeStorage'
import { RuleValidationError } from '../schema'

const rule = {
  id: 'test.hrv',
  name: 'HRV drop',
  metric: 'hrv_ms',
  window: '24h',
  aggregation: 'avg',
  compare: 'less_than',
  severity: 'warn',
  target: { type: 'absolute', value: 40 },
} as const

const secondRule = {
  id: 'test.stress',
  name: 'Stress elevated',
  metric: 'stress',
  window: '24h',
  aggregation: 'avg',
  compare: 'greater_than',
  severity: 'info',
  target: { type: 'absolute', value: 70 },
} as const

describe('createRulesRegistry', () => {
  it('registers, lists, and activates all rules by default', async () => {
    const storage = createFakeStorage()
    const registry = createRulesRegistry({ storage })
    await registry.register([rule, secondRule])
    expect(registry.list()).toHaveLength(2)
    expect(registry.getActive()).toHaveLength(2)
  })

  it('bumps rev on register + enable/disable', async () => {
    const storage = createFakeStorage()
    const registry = createRulesRegistry({ storage })
    const revBefore = registry.rev
    await registry.register([rule])
    expect(registry.rev).toBeGreaterThan(revBefore)
    const revAfterRegister = registry.rev
    await registry.disable(rule.id)
    expect(registry.rev).toBeGreaterThan(revAfterRegister)
  })

  it('persists disabled state across recreate', async () => {
    const storage = createFakeStorage()
    const first = createRulesRegistry({ storage })
    await first.register([rule])
    await first.disable(rule.id)
    expect(first.getActive()).toHaveLength(0)

    const second = createRulesRegistry({ storage })
    await second.register([rule])
    expect(second.getActive()).toHaveLength(0)
    expect(second.list()).toHaveLength(1)
  })

  it('enable + disable throw for unknown ruleId', async () => {
    const storage = createFakeStorage()
    const registry = createRulesRegistry({ storage })
    await expect(registry.enable('nope')).rejects.toThrow(RuleValidationError)
    await expect(registry.disable('nope')).rejects.toThrow(RuleValidationError)
  })

  it('getByMetric filters correctly', async () => {
    const storage = createFakeStorage()
    const registry = createRulesRegistry({ storage })
    await registry.register([rule, secondRule])
    expect(registry.getByMetric('hrv_ms')).toHaveLength(1)
    expect(registry.getByMetric('stress')).toHaveLength(1)
    expect(registry.getByMetric('spo2')).toHaveLength(0)
  })

  it('getByBrand filters by rule.brand ?? default', async () => {
    const storage = createFakeStorage()
    const registry = createRulesRegistry({ storage })
    await registry.register([
      rule, // no brand — inherits
      { ...secondRule, brand: 'other' },
    ])
    expect(registry.getByBrand('ziva')).toHaveLength(1)
    expect(registry.getByBrand('other')).toHaveLength(1)
  })

  it('subscribe fires on registration + enable/disable', async () => {
    const storage = createFakeStorage()
    const registry = createRulesRegistry({ storage })
    let hits = 0
    const unsub = registry.subscribe(() => {
      hits += 1
    })
    await registry.register([rule])
    await registry.disable(rule.id)
    await registry.enable(rule.id)
    unsub()
    await registry.disable(rule.id) // should not increment hits
    expect(hits).toBe(3)
  })

  it('register throws on bad rule (bubbles Zod / validator error)', async () => {
    const storage = createFakeStorage()
    const registry = createRulesRegistry({ storage })
    await expect(
      registry.register([{ ...rule, window: '1h' }]),
    ).rejects.toThrow()
  })
})
