import type { Rule } from '../schema'
import { describe, expect, it, vi } from 'vitest'
import { createFakeClock } from '../__fakes__/fakeClock'
import { createFakeEngine } from '../__fakes__/fakeEngine'
import { createFakeStorage } from '../__fakes__/fakeStorage'
import { createCompilerCache } from '../compiler-cache'
import { createEmitter } from '../emitter'
import { createEvaluator } from '../evaluator'
import { createRulesRegistry } from '../registry'
import { createThrottleStore } from '../throttle'

// Named for history; the metric is spo2 because hrv_ms is relative-only
// by decision D3 and cannot be registered with an absolute target.
const hrvRule = {
  id: 'test.hrv.drop',
  name: 'HRV drop',
  metric: 'spo2',
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
    storage,
    clock,
    analytics,
    registry,
    cache,
    throttle,
    emitter,
    familyMembersProvider,
    evaluator,
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
        // The generic fixture is spo2 (hrv_ms is relative-only by D3 and
        // cannot be registered with an absolute target), so the two rules
        // now span two tables rather than sharing one.
        affectedTables: ['spo2', 'hrv'],
      })
      expect(h.analytics.__calls).toHaveLength(2)
    })

    it('binds $userId / $brand / $familyId via params (never inlined)', async () => {
      const h = await harness()
      await h.registry.register([hrvRule])
      h.analytics.__setResult([])
      await h.evaluator.evaluateOnBatch({
        affectedUserIds: ['user-a'],
        affectedTables: ['spo2'],
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
      expect(call.sql).not.toContain('\'user-a\'')
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
        affectedTables: ['spo2'],
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
        affectedTables: ['spo2'],
      })
      expect(first).toHaveLength(1)

      // Immediately again — throttle should block, no execute call.
      const before = h.analytics.__calls.length
      const second = await h.evaluator.evaluateOnBatch({
        affectedUserIds: ['u1'],
        affectedTables: ['spo2'],
      })
      expect(second).toHaveLength(0)
      expect(h.analytics.__calls.length).toBe(before)
    })

    it('swallows execute errors and returns []', async () => {
      const h = await harness()
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }
      const storage = createFakeStorage()
      const clock = createFakeClock('2025-01-01T00:00:00Z')
      const analytics = createFakeEngine()
      const registry = createRulesRegistry({ storage })
      const cache = createCompilerCache()
      const throttle = createThrottleStore({ storage, clock })
      const emitter = createEmitter()
      const evaluator = createEvaluator({
        registry,
        cache,
        throttle,
        emitter,
        analytics,
        brand: 'ziva',
        familyId: 'fam1',
        familyMembersProvider: async () => ['u1'],
        clock,
        logger,
      })
      await registry.register([hrvRule])
      analytics.__setError(new Error('duckdb blew up'))
      const out = await evaluator.evaluateOnBatch({
        affectedUserIds: ['u1'],
        affectedTables: ['spo2'],
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
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }
      const evaluator = createEvaluator({
        registry,
        cache,
        throttle,
        emitter,
        analytics,
        brand: 'ziva',
        familyId: 'fam1',
        familyMembersProvider: async () => { throw new Error('rxdb offline') },
        clock,
        logger,
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

  describe('insight persistence + app event bus (fix RU-1)', () => {
    const criticalRule = {
      id: 'test.spo2.critical',
      name: 'SpO2 critically low',
      description: 'SpO2 dropped below the safe floor',
      metric: 'spo2',
      window: '6h',
      aggregation: 'min',
      compare: 'less_than',
      severity: 'critical',
      target: { type: 'absolute', value: 90 },
    } as const satisfies Partial<Rule> as Rule

    function makeBus() {
      return {
        emit: vi.fn(),
        subscribe: vi.fn(() => () => {}),
        subscribePattern: vi.fn(() => () => {}),
      }
    }

    it('writes an insight row with bound columns; rule critical maps to urgent', async () => {
      const h = await harness()
      await h.registry.register([criticalRule])
      h.analytics.__setResult([{ observed_value: 85, threshold_value: 90 }])

      const out = await h.evaluator.evaluateOnBatch({
        affectedUserIds: ['u1'],
        affectedTables: ['spo2'],
      })
      expect(out).toHaveLength(1)

      const insert = h.analytics.__calls.find(c => c.sql.startsWith('INSERT INTO insight'))
      expect(insert).toBeDefined()
      expect(insert!.sql).toContain(`'threshold'`)
      expect(insert!.params).toMatchObject({
        userId: 'u1',
        brand: 'ziva',
        familyId: 'fam1',
        ruleId: 'test.spo2.critical',
        metric: 'spo2',
        severity: 'urgent',
        title: 'SpO2 critically low',
        body: 'SpO2 dropped below the safe floor',
      })
      expect(insert!.params.insightId).toHaveLength(24)
      const evidence = JSON.parse(insert!.params.evidence as string)
      expect(evidence).toMatchObject({
        metric: 'spo2',
        observedValue: 85,
        thresholdValue: 90,
      })
    })

    it('emits threshold:violation and insight:insert on a configured bus', async () => {
      const storage = createFakeStorage()
      const clock = createFakeClock('2025-01-01T00:00:00Z')
      const analytics = createFakeEngine()
      const registry = createRulesRegistry({ storage })
      const bus = makeBus()
      const evaluator = createEvaluator({
        registry,
        cache: createCompilerCache(),
        throttle: createThrottleStore({ storage, clock }),
        emitter: createEmitter(),
        analytics,
        brand: 'ziva',
        familyId: 'fam1',
        familyMembersProvider: async () => ['u1'],
        clock,
        eventBus: bus,
      })
      await registry.register([criticalRule])
      analytics.__setResult([{ observed_value: 85, threshold_value: 90 }])

      await evaluator.evaluateOnBatch({
        affectedUserIds: ['u1'],
        affectedTables: ['spo2'],
      })

      const events = bus.emit.mock.calls
      const violationEvt = events.find(([name]) => name === 'threshold:violation')
      const insertEvt = events.find(([name]) => name === 'insight:insert')
      expect(violationEvt?.[1]).toMatchObject({
        ruleId: 'test.spo2.critical',
        userId: 'u1',
        metric: 'spo2',
        severity: 'urgent',
        observedValue: 85,
        thresholdValue: 90,
      })
      expect(insertEvt?.[1]).toMatchObject({ userId: 'u1', metric: 'spo2' })
      // Same insight_id links the bus events to the row.
      expect((violationEvt?.[1] as { insightId: string }).insightId)
        .toBe((insertEvt?.[1] as { insightId: string }).insightId)
    })

    it('insight INSERT failure: logged, violation still emitted, no insight:insert', async () => {
      const storage = createFakeStorage()
      const clock = createFakeClock('2025-01-01T00:00:00Z')
      const analytics = createFakeEngine()
      const registry = createRulesRegistry({ storage })
      const emitter = createEmitter()
      const bus = makeBus()
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }
      const original = analytics.execute.bind(analytics)
      analytics.execute = (async (sql: string, params?: Record<string, unknown>) => {
        if (sql.startsWith('INSERT INTO insight'))
          throw new Error('insight table on fire')
        return original(sql, params)
      }) as typeof analytics.execute
      const evaluator = createEvaluator({
        registry,
        cache: createCompilerCache(),
        throttle: createThrottleStore({ storage, clock }),
        emitter,
        analytics,
        brand: 'ziva',
        familyId: 'fam1',
        familyMembersProvider: async () => ['u1'],
        clock,
        eventBus: bus,
        logger,
      })
      await registry.register([hrvRule])
      analytics.__setResult([{ observed_value: 25, threshold_value: 40 }])
      const listener = vi.fn()
      emitter.on('violation', listener)

      const out = await evaluator.evaluateOnBatch({
        affectedUserIds: ['u1'],
        affectedTables: ['spo2'],
      })

      // Fire-and-forget: evaluation returns the violation and the private
      // emitter still fires despite the failed INSERT.
      expect(out).toHaveLength(1)
      expect(listener).toHaveBeenCalledOnce()
      expect(logger.error).toHaveBeenCalledWith(
        'rules.evaluator: insight insert failed',
        expect.objectContaining({ ruleId: 'test.hrv.drop' }),
      )
      const names = bus.emit.mock.calls.map(([name]) => name)
      expect(names).toContain('threshold:violation')
      expect(names).not.toContain('insight:insert')
      const payload = bus.emit.mock.calls.find(([n]) => n === 'threshold:violation')?.[1]
      expect((payload as { insightId: string | null }).insightId).toBeNull()
    })

    it('no bus configured: violation path resolves without throwing', async () => {
      const h = await harness()
      await h.registry.register([hrvRule])
      h.analytics.__setResult([{ observed_value: 25, threshold_value: 40 }])
      await expect(
        h.evaluator.evaluateOnBatch({ affectedUserIds: ['u1'], affectedTables: ['spo2'] }),
      ).resolves.toHaveLength(1)
    })

    it('a throwing bus subscriber never breaks the eval loop', async () => {
      const storage = createFakeStorage()
      const clock = createFakeClock('2025-01-01T00:00:00Z')
      const analytics = createFakeEngine()
      const registry = createRulesRegistry({ storage })
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }
      const bus = {
        emit: vi.fn(() => { throw new Error('subscriber exploded') }),
        subscribe: vi.fn(() => () => {}),
        subscribePattern: vi.fn(() => () => {}),
      }
      const evaluator = createEvaluator({
        registry,
        cache: createCompilerCache(),
        throttle: createThrottleStore({ storage, clock }),
        emitter: createEmitter(),
        analytics,
        brand: 'ziva',
        familyId: 'fam1',
        familyMembersProvider: async () => ['u1'],
        clock,
        eventBus: bus,
        logger,
      })
      await registry.register([hrvRule])
      analytics.__setResult([{ observed_value: 25, threshold_value: 40 }])

      const out = await evaluator.evaluateOnBatch({
        affectedUserIds: ['u1'],
        affectedTables: ['spo2'],
      })
      expect(out).toHaveLength(1)
      expect(logger.error).toHaveBeenCalledWith(
        'rules.evaluator: event bus emit threw',
        expect.objectContaining({ ruleId: 'test.hrv.drop' }),
      )
    })
  })
})
