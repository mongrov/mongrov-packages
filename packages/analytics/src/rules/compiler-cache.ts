/**
 * Memoization layer around `compileRule`.
 *
 * Keyed by `ruleId + registry revision`. Registry bumps `rev` on every
 * register/enable/disable, so a rule mutation transparently invalidates
 * its cached compilation on the next `getCompiled(rule, rev)` call.
 */

import type { Rule } from './schema'
import type { CompiledRule } from './types'
import { compileRule } from './compiler'

export interface CompilerCache {
  getCompiled: (rule: Rule, rev: number) => CompiledRule
  invalidate: (ruleId: string) => void
  size: () => number
}

export function createCompilerCache(): CompilerCache {
  const entries = new Map<string, { rev: number, compiled: CompiledRule }>()

  return {
    getCompiled(rule, rev) {
      const cached = entries.get(rule.id)
      if (cached && cached.rev === rev) {
        return cached.compiled
      }
      const compiled = compileRule(rule)
      entries.set(rule.id, { rev, compiled })
      return compiled
    },
    invalidate(ruleId) {
      entries.delete(ruleId)
    },
    size() {
      return entries.size
    },
  }
}
