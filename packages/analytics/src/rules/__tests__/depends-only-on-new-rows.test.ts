/**
 * `dependsOnlyOnNewRows` (zivaone_app#460 P17b, mongrov-packages#47).
 *
 * The scheduled pass may skip a flagged rule the batch pass already answered
 * in the same cycle — but only when nothing it reads can have changed. These
 * pin both halves: the skip happens when it is safe, and every way the answer
 * could have changed (rows, inputs, registry, a failed or missing batch read,
 * a later cycle) makes the scheduled pass run the query again. The validator
 * half pins that the flag cannot be put on a rule the clock can fire.
 */
import type { Rule } from '../schema'
import { describe, expect, it, vi } from 'vitest'
import { createFakeClock } from '../__fakes__/fakeClock'
import { createFakeEngine } from '../__fakes__/fakeEngine'
import { createFakeStorage } from '../__fakes__/fakeStorage'
import { USER_SETTING_PARAM } from '../compiler'
import { createCompilerCache } from '../compiler-cache'
import { luminxDefaults, vivaDefaults, yogaringDefaults, zivaDefaults } from '../defaults'
import { createEmitter } from '../emitter'
import { createEvaluator } from '../evaluator'
import { createRulesEngine } from '../factory'
import { createRulesRegistry } from '../registry'
import { RuleSchema, RuleValidationError } from '../schema'
import { createThrottleStore } from '../throttle'
import { validateRule } from '../validator'

const flagged = RuleSchema.parse({
  id: 't.spo2-low',
  name: 'SpO2 low',
  metric: 'spo2',
  window: '24h',
  aggregation: 'min',
  compare: 'less_than',
  severity: 'warn',
  target: { type: 'user_setting', key: 'user:spo2SafeLevel', defaultValue: 90 },
  dependsOnlyOnNewRows: true,
})

const unflagged = RuleSchema.parse({ ...flagged, id: 't.spo2-low-unflagged', dependsOnlyOnNewRows: undefined })

async function harness(rules: Rule[] = [flagged, unflagged]) {
  const storage = createFakeStorage()
  const clock = createFakeClock('2025-01-01T00:00:00Z')
  const analytics = createFakeEngine()
  const registry = createRulesRegistry({ storage })
  const evaluator = createEvaluator({
    registry,
    cache: createCompilerCache(),
    throttle: createThrottleStore({ storage, clock }),
    emitter: createEmitter(),
    analytics,
    brand: 'ziva',
    familyId: 'fam1',
    familyMembersProvider: vi.fn(async () => ['u1', 'u2']),
    clock,
    storage,
  })
  await registry.register(rules)
  analytics.__setResult([])
  const reset = () => analytics.__calls.splice(0)
  const batch = () => evaluator.evaluateOnBatch({ affectedUserIds: ['u1'], affectedTables: ['spo2'] })
  return { storage, analytics, registry, evaluator, reset, batch }
}

describe('dependsOnlyOnNewRows — the scheduled pass', () => {
  it('skips a flagged rule the batch pass answered, for that user only; unflagged rules still run', async () => {
    const h = await harness()
    await h.batch()
    expect(h.analytics.__calls).toHaveLength(2) // both rules, u1
    h.reset()

    await h.evaluator.evaluateScheduled()
    // flagged × u1 skipped; flagged × u2 (not in the batch) and unflagged × both run.
    const calls = h.analytics.__calls.map(c => c.params.userId)
    expect(calls).toHaveLength(3)
    expect(calls.filter(u => u === 'u1')).toHaveLength(1)
    expect(calls.filter(u => u === 'u2')).toHaveLength(2)
  })

  it('runs it when rows arrived after the batch read', async () => {
    const h = await harness([flagged])
    await h.batch()
    h.evaluator.noteRowsArrived()
    h.reset()
    await h.evaluator.evaluateScheduled()
    expect(h.analytics.__calls.map(c => c.params.userId)).toEqual(['u1', 'u2'])
  })

  it('runs it when rows arrived DURING the batch read', async () => {
    const h = await harness([flagged])
    const execute = h.analytics.execute.bind(h.analytics)
    h.analytics.execute = (async (sql: string, params?: Record<string, unknown>) => {
      const out = await execute(sql, params)
      h.evaluator.noteRowsArrived() // landed while the query ran
      return out
    }) as typeof h.analytics.execute
    await h.batch()
    h.reset()
    await h.evaluator.evaluateScheduled()
    expect(h.analytics.__calls.map(c => c.params.userId)).toContain('u1')
  })

  it('runs it when an eval-time input changed (the user moved their safe level)', async () => {
    const h = await harness([flagged])
    await h.batch()
    await h.storage.set('analytics:u1:user:spo2SafeLevel', 93)
    h.reset()
    await h.evaluator.evaluateScheduled()
    const u1 = h.analytics.__calls.find(c => c.params.userId === 'u1')
    expect(u1?.params[USER_SETTING_PARAM]).toBe(93)
  })

  it('runs it when the registry changed after the batch read', async () => {
    const h = await harness([flagged])
    await h.batch()
    await h.registry.register([unflagged])
    h.reset()
    await h.evaluator.evaluateScheduled()
    expect(h.analytics.__calls.filter(c => c.params.userId === 'u1')).toHaveLength(2)
  })

  it('runs it when the batch read failed', async () => {
    const h = await harness([flagged])
    h.analytics.__setError(new Error('boom'))
    await h.batch()
    h.analytics.__setResult([])
    h.reset()
    await h.evaluator.evaluateScheduled()
    expect(h.analytics.__calls.map(c => c.params.userId)).toEqual(['u1', 'u2'])
  })

  it('reuses a batch read once: the next cycle with no batch pass runs it', async () => {
    const h = await harness([flagged])
    await h.batch()
    await h.evaluator.evaluateScheduled()
    h.reset()
    await h.evaluator.evaluateScheduled()
    expect(h.analytics.__calls.map(c => c.params.userId)).toEqual(['u1', 'u2'])
  })

  it('a scheduled pass that returns early still closes the cycle', async () => {
    const h = await harness([flagged])
    await h.batch()
    h.analytics.__setState('detached')
    await expect(h.evaluator.evaluateScheduled()).rejects.toThrow()
    h.analytics.__setState('attached')
    h.reset()
    await h.evaluator.evaluateScheduled()
    expect(h.analytics.__calls.map(c => c.params.userId)).toEqual(['u1', 'u2'])
  })

  it('never skips in the batch pass itself', async () => {
    const h = await harness([flagged])
    await h.batch()
    h.reset()
    await h.batch()
    expect(h.analytics.__calls).toHaveLength(1)
  })

  it('is reachable through createRulesEngine', async () => {
    const storage = createFakeStorage()
    const analytics = createFakeEngine()
    analytics.__setResult([])
    const engine = createRulesEngine({
      analytics,
      storage,
      familyMembersProvider: async () => ['u1'],
      brand: 'ziva',
      familyId: 'fam1',
    })
    await engine.register([flagged])
    await engine.evaluateOnBatch({ affectedUserIds: ['u1'], affectedTables: ['spo2'] })
    analytics.__calls.splice(0)
    await engine.evaluateScheduled()
    expect(analytics.__calls).toHaveLength(0)
    engine.noteRowsArrived?.()
    await engine.evaluateOnBatch({ affectedUserIds: ['u1'], affectedTables: ['spo2'] })
    engine.noteRowsArrived?.()
    analytics.__calls.splice(0)
    await engine.evaluateScheduled()
    expect(analytics.__calls).toHaveLength(1)
  })
})

describe('dependsOnlyOnNewRows — the validator', () => {
  const base = {
    id: 't.r',
    name: 'r',
    metric: 'spo2',
    window: '24h',
    aggregation: 'min',
    compare: 'less_than',
    severity: 'warn',
    target: { type: 'absolute', value: 90 },
    dependsOnlyOnNewRows: true,
  }
  const parse = (over: Record<string, unknown>) => RuleSchema.parse({ ...base, ...over })
  const ok = (over: Record<string, unknown>) => expect(() => validateRule(parse(over))).not.toThrow()
  const refused = (over: Record<string, unknown>, why: RegExp) => {
    expect(() => validateRule(parse(over))).toThrow(RuleValidationError)
    expect(() => validateRule(parse(over))).toThrow(why)
  }

  it('accepts shapes the clock can only stop from firing', () => {
    ok({})
    ok({ compare: 'less_than_or_equal' })
    ok({ aggregation: 'max', compare: 'greater_than' })
    ok({ aggregation: 'max', compare: 'greater_than_or_equal' })
    ok({ aggregation: 'count', compare: 'greater_than' })
    ok({ metric: 'device_battery', window: '1h', aggregation: 'last', compare: 'less_than', target: { type: 'absolute', value: 20 } })
    ok({ metric: 'stress', aggregation: 'avg', compare: 'greater_than_or_equal', consecutive: 3, target: { type: 'user_setting', key: 'user:stressFlagLevel', defaultValue: 66 } })
    ok({ target: { type: 'range', min: 90, max: 100 } })
  })

  it('refuses window aggregates the clock can push toward the threshold', () => {
    refused({ aggregation: 'avg' }, /avg less_than can start firing/)
    refused({ aggregation: 'sum', metric: 'activity_steps' }, /sum less_than/)
    refused({ aggregation: 'min', compare: 'greater_than' }, /min greater_than/)
    refused({ aggregation: 'max', compare: 'less_than' }, /max less_than/)
    // "no reading in N hours" — the disconnect rules' exact shape.
    refused({ metric: 'device_battery', aggregation: 'count', compare: 'equals', target: { type: 'absolute', value: 0 } }, /count equals/)
    refused({ aggregation: 'count', compare: 'less_than' }, /count less_than/)
    refused({ target: { type: 'range', min: 90, max: 100 }, compare: 'between' }, /min between/)
  })

  it('refuses every clock- or state-dependent shape, naming the dependency', () => {
    refused({ metric: 'temp_c', window: '30d', cadence: 'day', consecutive: 2 }, /day cadence/)
    refused({ metric: 'activity_steps', window: '7d', aggregation: 'max', compare: 'greater_than', minDays: 6 }, /minDays/)
    refused({ context: 'asleep' }, /context 'asleep'/)
    refused({ context: 'resting' }, /context 'resting'/)
    refused({ metric: 'sleep_total_minutes', window: '3d' }, /per-session/)
    refused({ aggregation: 'min', target: { type: 'baseline_percent', windowDays: 7, percent: 70 } }, /reads a baseline/)
    refused({ metric: 'temp_c', window: '30d', aggregation: 'max', compare: 'greater_than', target: { type: 'baseline_offset', windowDays: 30, offset: 0.3, direction: 'above' } }, /reads a baseline/)
    refused({ rawSql: 'SELECT 1 AS observed_value, 1 AS threshold_value' }, /rawSql/)
  })

  it('every shipped catalog loads, and exactly the row-driven ziva rules carry the flag', () => {
    const all = [...zivaDefaults, ...luminxDefaults, ...vivaDefaults, ...yogaringDefaults]
    for (const r of all) expect(() => validateRule(r)).not.toThrow()
    expect(all.filter(r => r.dependsOnlyOnNewRows).map(r => r.id).sort()).toEqual([
      'ziva.spo2-safe-level',
      'ziva.stress-flag-level',
    ])
  })
})
