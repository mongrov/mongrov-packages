/**
 * Rule contexts: `any` is the engine's; every other one is a pack's
 * (`pack.rules.contexts`), a JOIN restricting the metric relation `m`.
 */

import type { RuleContextArgs, RulePack } from '../core/packs'
import { packExtensions } from '../core/packs'

function packContexts(): Map<string, (args: RuleContextArgs) => string> {
  const out = new Map<string, (args: RuleContextArgs) => string>()
  for (const rules of packExtensions<RulePack>('rules')) {
    for (const [name, join] of Object.entries(rules.contexts ?? {})) {
      if (!out.has(name))
        out.set(name, join)
    }
  }
  return out
}

/** Every context a rule may name. */
export function ruleContextNames(): string[] {
  return ['any', ...packContexts().keys()]
}

/** The JOIN for a context (`''` for `any`). */
export function contextJoin(context: string, args: RuleContextArgs): string {
  if (context === 'any')
    return ''
  const join = packContexts().get(context)
  if (!join)
    throw new Error(`unknown rule context '${context}'`)
  return join(args)
}
