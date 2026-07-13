// @vitest-environment jsdom

/**
 * Hook coverage:
 *   1. `useRuleViolations` buffers violations, respects `limit`, `clear()` empties.
 *   2. `useRuleRegistry` reflects register/enable/disable via useSyncExternalStore.
 */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createRulesEngine } from '../factory'
import { createFakeEngine } from '../__fakes__/fakeEngine'
import { createFakeStorage } from '../__fakes__/fakeStorage'
import { createFakeClock } from '../__fakes__/fakeClock'
import { useRuleRegistry } from '../hooks/useRuleRegistry'
import { useRuleViolations } from '../hooks/useRuleViolations'
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
  name: 'Stress',
  metric: 'stress',
  window: '24h',
  aggregation: 'avg',
  compare: 'greater_than',
  severity: 'info',
  target: { type: 'absolute', value: 70 },
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
  return { engine, analytics }
}

afterEach(() => cleanup())

describe('useRuleViolations', () => {
  it('accumulates newest-first and enforces limit', async () => {
    const { engine, analytics } = build()
    await engine.register([hrvRule])
    analytics.__setResult([{ observed_value: 20, threshold_value: 40 }])

    const { result } = renderHook(() => useRuleViolations(engine, { limit: 2 }))
    expect(result.current.violations).toEqual([])

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await engine.evaluateOnBatch({
          affectedUserIds: [`u${i}`],
          affectedTables: ['hrv'],
        })
      })
    }
    expect(result.current.violations).toHaveLength(2)
    expect(result.current.violations[0].userId).toBe('u2')
  })

  it('clear() empties the feed', async () => {
    const { engine, analytics } = build()
    await engine.register([hrvRule])
    analytics.__setResult([{ observed_value: 20, threshold_value: 40 }])

    const { result } = renderHook(() => useRuleViolations(engine))
    await act(async () => {
      await engine.evaluateOnBatch({
        affectedUserIds: ['u1'],
        affectedTables: ['hrv'],
      })
    })
    expect(result.current.violations).toHaveLength(1)
    act(() => {
      result.current.clear()
    })
    expect(result.current.violations).toHaveLength(0)
  })
})

describe('useRuleRegistry', () => {
  it('returns the registered rules and re-renders on mutation', async () => {
    const { engine } = build()
    const { result } = renderHook(() => useRuleRegistry(engine))
    expect(result.current.rules).toEqual([])

    await act(async () => {
      await engine.register([hrvRule, stressRule])
    })
    expect(result.current.rules).toHaveLength(2)

    await act(async () => {
      await result.current.disable(hrvRule.id)
    })
    // list() reflects both rules regardless of enabled state.
    expect(result.current.rules).toHaveLength(2)
  })
})
