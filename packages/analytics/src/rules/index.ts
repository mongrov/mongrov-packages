/**
 * @mongrov/analytics/rules — structured threshold rule engine.
 *
 * See `README.md` for authoring rules, sampling minimums, brand default
 * catalogs, and hooks. Consumers typically:
 *
 * ```ts
 * import {
 *   createRulesEngine,
 *   defaults,
 * } from '@mongrov/analytics/rules';
 *
 * const engine = createRulesEngine({ analytics, storage, brand: 'ziva', ... });
 * await engine.register(defaults.zivaDefaults);
 * engine.on('violation', (v) => notify(v));
 * ```
 */

// R1 — schema + types
export {
  RuleSchema,
  RuleValidationError,
  TargetSchema,
  ThrottleSchema,
  AGGREGATIONS,
  COMPARES,
  SEVERITIES,
  WINDOWS,
} from './schema'
export type {
  Aggregation,
  Compare,
  Rule,
  Severity,
  Target,
  Throttle,
  Window,
} from './schema'

export type {
  Clock,
  CompiledRule,
  FlushSummary,
  RuleSeverity,
  RuleViolation,
  RulesEngine,
  RulesEngineConfig,
  RulesLogger,
  Unsubscribe,
} from './types'

// R2 — validator
export { allowedWindowsFor, validateRule } from './validator'

// R3 — compiler + cache
export { compileRule, sanitizeIdent } from './compiler'
export { createCompilerCache, type CompilerCache } from './compiler-cache'

// R4-R6 — registry / throttle / emitter (exposed for advanced composition
// or test doubles; typical apps go through `createRulesEngine`).
export {
  createRulesRegistry,
  type CreateRegistryConfig,
  type RulesRegistry,
} from './registry'
export {
  createThrottleStore,
  type CreateThrottleConfig,
  type ThrottleStore,
} from './throttle'
export {
  createEmitter,
  type CreateEmitterConfig,
  type RulesEmitter,
} from './emitter'

// R9 — factory
export { createRulesEngine } from './factory'

// R8 — brand defaults
export * as defaults from './defaults'

// R10 — hooks
export {
  useRuleViolations,
  type UseRuleViolationsOptions,
  type UseRuleViolationsResult,
} from './hooks/useRuleViolations'
export {
  useRuleRegistry,
  type UseRuleRegistryResult,
} from './hooks/useRuleRegistry'
