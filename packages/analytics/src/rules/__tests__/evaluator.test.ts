import { describe, expect, it, vi } from 'vitest'
import { createFakeEngine } from '../__fakes__/fakeEngine'
import { createFakeStorage } from '../__fakes__/fakeStorage'
import { createFakeClock } from '../__fakes__/fakeClock'
import { createCompilerCache } from '../compiler-cache'
import { createEmitter } from '../emitter'
import { createEvaluator } from '../evaluator'
import { createRulesRegistry } from '../registry'
import { createThrottleStore } from '../throttle'
import type { Rule } from '../schema'

const hrvRule = {
  id: 'test.hrv.drop',
  name: 'HRV drop',
  metric: 'hrv_ms',
  window: '24h',
  aggregation: 'avg',
  compare: 'less_than',
  severity: 'warn',
  target: { type: 'absolute', value: 40 },
} as const satisfies Partial<Rule> as Rule

const stressRule = {
  id: 'test.stress.high',
  name: 'Stress elevated',
  metric: 'stress',
  window: '24h',
  aggregation: 'avg',
  compare: 'greater_than',
  severity: 'info',
  target: { type: 'absolute', value: 70 },
} as const satisfies Partial<Rule> as Rule

async function harness() {
  const storage = createFakeStorage()
  const clock = createFakeClock('2025-01-01T00:00:00Z')
  const analytics = createFakeEngine()
  const registry = createRulesRegistry({ storage })
  const cache = createCompilerCache()
  const throttle = createThrottleStore({ storage, clock })
  const emitter = createEmitter()
  const familyMembersProvider = vi.fn(async () => ['u1', 'u2'])
  const evaluator = createEvaluator({
    registry,
    cache,
    throttle,
    emitter,
    analytics,
    brand: 'ziva',
    familyId: 'fam1',
    familyMembersProvider,
    clock,
  })
  return {
    storage, clock, analytics, registry, cache, throttle, emitter,
    familyMembersProvider, evaluator,
  }
}

describe('createEvaluator', () => {
  describe('evaluateOnBatch', () => {
    it('runs only rules whose metric table intersects affectedTables', async () => {
      const h = await harness()
      await h.registry.register([hrvRule, stressRule])
      h.analytics.__setResult([]) // no violations

      await h.evaluator.evaluateOnBatch({
        affectedUserIds: ['u1'],
        affectedTables: ['heart_rate'], // neither rule matches
      })
      expect(h.analytics.__calls).toHaveLength(0)

      await h.evaluator.evaluateOnBatch({
        affectedUserIds: ['u1'],
        affectedTables: ['hrv'], // both rules match (hrv_ms, stress → hrv table)
      })
      expect(h.analytics.__calls).toHaveLength(2)
    })

    it('binds $userId / $brand / $familyId via params (never inlined)', async () => {
      const h = await harness()
      await h.registry.register([hrvRule])
      h.analytics.__setResult([])
      await h.evaluator.evaluateOnBatch({
        affectedUserIds: ['user-a'],
        affectedTables: ['hrv'],
      })
      const call = h.analytics.__calls[0]
      expect(call.sql).toContain('$userId')
      expect(call.sql).toContain('$brand')
      expect(call.sql).toContain('$familyId')
      expect(call.params).toMatchObject({
        userId: 'user-a',
        brand: 'ziva',
        familyId: 'fam1',
      })
      expect(call.sql).not.toContain("'user-a'")
    })

    it('emits + returns a violation when a row is returned', async () => {
      const h = await harness()
      await h.registry.register([hrvRule])
      h.analytics.__setResult([
        { observed_value: 25, threshold_value: 40 },
      ])
      const listener = vi.fn()
      h.emitter.on('violation', listener)

      const out = await h.evaluator.evaluateOnBatch({
        affectedUserIds: ['u1'],
        affectedTables: ['hrv'],
      })
      expect(out).toHaveLength(1)
      expect(listener).toHaveBeenCalledOnce()
      expect(out[0]).toMatchObject({
        ruleId: 'test.hrv.drop',
        userId: 'u1',
        familyId: 'fam1',
        brand: 'ziva',
        observedValue: 25,
        thresholdValue: 40,
        severity: 'warn',
      })
    })

    it('records fire so back-to-back evaluations respect the throttle', async () => {
      const h = await harness()
      await h.registry.register([hrvRule])
      h.analytics.__setResult([
        { observed_value: 25, threshold_value: 40 },
      ])
      const first = await h.evaluator.evaluateOnBatch({
        affectedUserIds: ['u1'],
        affectedTables: ['hrv'],
      })
      expect(first).toHaveLength(1)

      // Immediately again — throttle should block, no execute call.
      const before = h.analytics.__calls.length
      const second = await h.evaluator.evaluateOnBatch({
        affectedUserIds: ['u1'],
        affectedTables: ['hrv'],
      })
      expect(second).toHaveLength(0)
      expect(h.analytics.__calls.length).toBe(before)
    })

    it('swallows execute errors and returns []', async () => {
      const h = await harness()
      const logger = {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      }
      const storage = createFakeStorage()
      const clock = createFakeClock('2025-01-01T00:00:00Z')
      const analytics = createFakeEngine()
      const registry = createRulesRegistry({ storage })
      const cache = createCompilerCache()
      const throttle = createThrottleStore({ storage, clock })
      const emitter = createEmitter()
      const evaluator = createEvaluator({
        registry, cache, throttle, emitter, analytics,
        brand: 'ziva', familyId: 'fam1',
        familyMembersProvider: async () => ['u1'],
        clock, logger,
      })
      await registry.register([hrvRule])
      analytics.__setError(new Error('duckdb blew up'))
      const out = await evaluator.evaluateOnBatch({
        affectedUserIds: ['u1'],
        affectedTables: ['hrv'],
      })
      expect(out).toEqual([])
      expect(logger.error).toHaveBeenCalled()
      void h
    })
  })

  describe('evaluateScheduled', () => {
    it('fans out over familyMembersProvider members', async () => {
      const h = await harness()
      await h.registry.register([hrvRule])
      h.analytics.__setResult([])
      await h.evaluator.evaluateScheduled()
      expect(h.familyMembersProvider).toHaveBeenCalledWith({
        brand: 'ziva',
        familyId: 'fam1',
      })
      expect(h.analytics.__calls).toHaveLength(2) // one per member
      const userIds = h.analytics.__calls.map(c => c.params.userId)
      expect(userIds).toEqual(['u1', 'u2'])
    })

    it('returns [] and logs on familyMembersProvider error', async () => {
      const storage = createFakeStorage()
      const clock = createFakeClock('2025-01-01T00:00:00Z')
      const analytics = createFakeEngine()
      const registry = createRulesRegistry({ storage })
      const cache = createCompilerCache()
      const throttle = createThrottleStore({ storage, clock })
      const emitter = createEmitter()
      const logger = {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      }
      const evaluator = createEvaluator({
        registry, cache, throttle, emitter, analytics,
        brand: 'ziva', familyId: 'fam1',
        familyMembersProvider: async () => { throw new Error('rxdb offline') },
        clock, logger,
      })
      await registry.register([hrvRule])
      const out = await evaluator.evaluateScheduled()
      expect(out).toEqual([])
      expect(logger.error).toHaveBeenCalled()
    })

    it('short-circuits when no active rules', async () => {
      const h = await harness()
      const out = await h.evaluator.evaluateScheduled()
      expect(out).toEqual([])
      expect(h.familyMembersProvider).not.toHaveBeenCalled()
    })
  })
})
