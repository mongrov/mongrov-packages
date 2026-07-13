/**
 * `useRuleRegistry(engine)` — live registry state.
 *
 * Uses `useSyncExternalStore` bound to `engine.subscribeRegistry` so the
 * component re-renders on register / enable / disable. `enable` + `disable`
 * are stable references passed through from the engine.
 */

import { useMemo, useSyncExternalStore, useCallback } from 'react'
import type { Rule } from '../schema'
import type { RulesEngine } from '../types'

export interface UseRuleRegistryResult {
  rules: Rule[]
  enable(ruleId: string): Promise<void>
  disable(ruleId: string): Promise<void>
}

interface Cache {
  subscribe: (onStoreChange: () => void) => () => void
  get: () => Rule[]
}

function makeCache(engine: RulesEngine): Cache {
  let snapshot = engine.list()
  return {
    subscribe: (onStoreChange) => engine.subscribeRegistry(() => {
      snapshot = engine.list()
      onStoreChange()
    }),
    get: () => snapshot,
  }
}

export function useRuleRegistry(engine: RulesEngine): UseRuleRegistryResult {
  const cache = useMemo(() => makeCache(engine), [engine])
  const rules = useSyncExternalStore(cache.subscribe, cache.get, cache.get)

  const enable = useCallback((ruleId: string) => engine.enable(ruleId), [engine])
  const disable = useCallback((ruleId: string) => engine.disable(ruleId), [engine])

  return { rules, enable, disable }
}
