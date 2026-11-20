/**
 * Sprint 5 T-23 — KVStore-bound thresholds.
 *
 * The user-visible promise this covers: drag the safe level in the ⚙ sheet,
 * hit Save, and the *same shipped rule* fires at the new number on the next
 * batch — no recompile, no per-user rule rows.
 *
 * T-27 (the two shipped SpO₂ catalog rules coexisting) lives with the catalog
 * in the app's health pack (`rules/__tests__/spo2-rules-coexist.test.ts`).
 */

import { describe, expect, it } from 'vitest'

import { primaryDefaults } from '../../__tests__/packs/health/rules'
import { createFakeEngine } from '../__fakes__/fakeEngine'
import { createFakeStorage } from '../__fakes__/fakeStorage'

import { USER_SETTING_PARAM } from '../compiler'
import { createRulesEngine } from '../factory'

const CTX = { brand: 'acme', familyId: 'fam1' }
const BATCH = { affectedUserIds: ['alice'], affectedTables: ['spo2'] as const }

function setup(opts: { storedSafeLevel?: number } = {}) {
  const engine = createFakeEngine()
  const storage = createFakeStorage()
  if (opts.storedSafeLevel !== undefined) {
    void storage.set('analytics:alice:user:spo2SafeLevel', opts.storedSafeLevel)
  }
  const rules = createRulesEngine({
    analytics: engine,
    storage,
    brand: CTX.brand,
    familyId: CTX.familyId,
    familyMembersProvider: async () => ['alice'],
  })
  return { engine, storage, rules }
}

/** The safe-level rule, as actually shipped. */
const safeLevelRule = primaryDefaults.find(r => r.id === 'acme.spo2-safe-level')!

describe('T-23 — threshold resolved from KVStore at eval time', () => {
  it('binds the stored value when the user has set one', async () => {
    const { engine, rules } = setup({ storedSafeLevel: 92 })
    await rules.register([safeLevelRule])
    engine.__setResult([{ observed_value: 89, threshold_value: 92 }])

    await rules.evaluateOnBatch({ ...BATCH, affectedTables: ['spo2'] })

    const call = engine.__calls.find(c => c.sql.includes(USER_SETTING_PARAM))
    expect(call).toBeDefined()
    expect(call!.params[USER_SETTING_PARAM]).toBe(92)
  })

  it('falls back to defaultValue when the key is unset', async () => {
    const { engine, rules } = setup()
    await rules.register([safeLevelRule])
    engine.__setResult([{ observed_value: 88, threshold_value: 90 }])

    await rules.evaluateOnBatch({ ...BATCH, affectedTables: ['spo2'] })

    const call = engine.__calls.find(c => c.sql.includes(USER_SETTING_PARAM))!
    expect(call.params[USER_SETTING_PARAM]).toBe(90)
  })

  it('coerces a stringified value — MMKV round-trips numbers as strings', async () => {
    const { engine, storage, rules } = setup()
    await storage.set('analytics:alice:user:spo2SafeLevel', '93')
    await rules.register([safeLevelRule])
    engine.__setResult([{ observed_value: 89, threshold_value: 93 }])

    await rules.evaluateOnBatch({ ...BATCH, affectedTables: ['spo2'] })

    const call = engine.__calls.find(c => c.sql.includes(USER_SETTING_PARAM))!
    expect(call.params[USER_SETTING_PARAM]).toBe(93)
  })

  it('falls back rather than binding garbage', async () => {
    // A broken setting must not silence the alert the user asked for.
    const { engine, storage, rules } = setup()
    await storage.set('analytics:alice:user:spo2SafeLevel', 'not a number')
    await rules.register([safeLevelRule])
    engine.__setResult([])

    await rules.evaluateOnBatch({ ...BATCH, affectedTables: ['spo2'] })

    const call = engine.__calls.find(c => c.sql.includes(USER_SETTING_PARAM))!
    expect(call.params[USER_SETTING_PARAM]).toBe(90)
  })

  it('re-reads across batches so a Save takes effect next cycle', async () => {
    const { engine, storage, rules } = setup({ storedSafeLevel: 90 })
    await rules.register([safeLevelRule])
    engine.__setResult([])

    await rules.evaluateOnBatch({ ...BATCH, affectedTables: ['spo2'] })
    expect(engine.__calls.at(-1)!.params[USER_SETTING_PARAM]).toBe(90)

    // User drags the slider and saves.
    await storage.set('analytics:alice:user:spo2SafeLevel', 94)

    await rules.evaluateOnBatch({ ...BATCH, affectedTables: ['spo2'] })
    expect(engine.__calls.at(-1)!.params[USER_SETTING_PARAM]).toBe(94)
  })

  it('isolates per user', async () => {
    const { engine, storage, rules } = setup({ storedSafeLevel: 92 })
    await storage.set('analytics:bob:user:spo2SafeLevel', 88)
    await rules.register([safeLevelRule])
    engine.__setResult([])

    await rules.evaluateOnBatch({
      affectedUserIds: ['alice', 'bob'],
      affectedTables: ['spo2'],
    })

    const bound = engine.__calls
      .filter(c => c.sql.includes(USER_SETTING_PARAM))
      .map(c => c.params[USER_SETTING_PARAM])
    expect(bound).toEqual([92, 88])
  })

  it('records settingsUsed on the violation for support triage', async () => {
    const { engine, rules } = setup({ storedSafeLevel: 92 })
    await rules.register([safeLevelRule])
    engine.__setResult([{ observed_value: 89, threshold_value: 92 }])

    const [violation] = await rules.evaluateOnBatch({
      ...BATCH,
      affectedTables: ['spo2'],
    })

    // "The alert fired at the wrong number" is otherwise unanswerable.
    expect(violation.evidence.settingsUsed).toEqual({
      key: 'user:spo2SafeLevel',
      value: 92,
    })
  })
})
