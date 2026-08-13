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

// R3 — compiler + cache
export {
  type Baseline,
  type BaselineReader,
  type BaselineReaderConfig,
  createBaselineReader,
} from './baseline-reader'
export { compileRule, emitContextJoin, sanitizeIdent, USER_SETTING_PARAM, viewFor } from './compiler'

export { type CompilerCache, createCompilerCache } from './compiler-cache'

// R8 — brand defaults
export * as defaults from './defaults'

export {
  createEmitter,
  type CreateEmitterConfig,
  type RulesEmitter,
} from './emitter'
// R9 — factory
export { createRulesEngine } from './factory'
export {
  useRuleRegistry,
  type UseRuleRegistryResult,
} from './hooks/useRuleRegistry'

// R10 — hooks
export {
  useRuleViolations,
  type UseRuleViolationsOptions,
  type UseRuleViolationsResult,
} from './hooks/useRuleViolations'
// R4-R6 — registry / throttle / emitter (exposed for advanced composition
// or test doubles; typical apps go through `createRulesEngine`).
export {
  type CreateRegistryConfig,
  createRulesRegistry,
  type RulesRegistry,
} from './registry'
// R1 — schema + types
export {
  AGGREGATIONS,
  COMPARES,
  RuleSchema,
  RuleValidationError,
  SEVERITIES,
  TargetSchema,
  ThrottleSchema,
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

export {
  type CreateThrottleConfig,
  createThrottleStore,
  type ThrottleStore,
} from './throttle'

export type {
  Clock,
  CompiledRule,
  FlushSummary,
  RulesEngine,
  RulesEngineConfig,
  RuleSeverity,
  RulesLogger,
  RuleViolation,
  Unsubscribe,
} from './types'
// R2 — validator
export { allowedWindowsFor, validateRule } from './validator'
