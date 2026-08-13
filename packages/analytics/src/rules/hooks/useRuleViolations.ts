/**
 * `useRuleViolations(engine, options?)` — session-scoped violation feed.
 *
 * Subscribes to `engine.on('violation', ...)` for the lifetime of the
 * component and buffers the most-recent `limit` violations in state. On
 * unmount the subscription tears down.
 *
 * React is an optional peer of `@mongrov/analytics`; this file is only
 * imported when the app pulls the `/rules` subpath.
 */

import type { RulesEngine, RuleViolation } from '../types'
import { useCallback, useEffect, useState } from 'react'

const DEFAULT_LIMIT = 50

export interface UseRuleViolationsOptions {
  /** Maximum number of retained violations. Default `50`. */
  limit?: number
}

export interface UseRuleViolationsResult {
  violations: RuleViolation[]
  clear: () => void
}

export function useRuleViolations(
  engine: RulesEngine,
  options?: UseRuleViolationsOptions,
): UseRuleViolationsResult {
  const limit = options?.limit ?? DEFAULT_LIMIT
  const [violations, setViolations] = useState<RuleViolation[]>([])

  useEffect(() => {
    const unsub = engine.on('violation', (v) => {
      setViolations((prev) => {
        const next = [v, ...prev]
        if (next.length > limit)
          next.length = limit
        return next
      })
    })
    return unsub
  }, [engine, limit])

  const clear = useCallback(() => {
    setViolations([])
  }, [])

  return { violations, clear }
}
