/**
 * @mongrov/analytics/rules — structured threshold rule engine.
 *
 * See `README.md` for authoring rules, sampling minimums, TOML rule
 * catalogs, and hooks. Consumers typically:
 *
 * ```ts
 * import {
 *   createRulesEngine,
 *   defaults,
 * } from '@mongrov/analytics/rules';
 *
 * const engine = createRulesEngine({ analytics, storage, brand: 'mybrand', ... });
 * await engine.register(myPack.defaultRules);
 * engine.on('violation', (v) => notify(v));
 * ```
 */

// R2 — validator
export { userSettingKey } from '../core/user-setting-key'
// Compiler + cache
export { compileRule, emitContextJoin, MIN_DAY_READINGS_FRACTION, minDayReadings, sanitizeIdent, USER_SETTING_PARAM, viewFor } from './compiler'
export { type CompilerCache, createCompilerCache } from './compiler-cache'

export { contextJoin, ruleContextNames } from './contexts'

// TOML rule catalogs

export { parseCatalog, type ParseCatalogOptions } from './defaults/loader'
export {
  createEmitter,
  type CreateEmitterConfig,
  type RulesEmitter,
} from './emitter'
// Factory
export { createRulesEngine } from './factory'

export {
  useRuleRegistry,
  type UseRuleRegistryResult,
} from './hooks/useRuleRegistry'
// Hooks
export {
  useRuleViolations,
  type UseRuleViolationsOptions,
  type UseRuleViolationsResult,
} from './hooks/useRuleViolations'
// Registry / throttle / emitter (exposed for advanced composition
// or test doubles; typical apps go through `createRulesEngine`).
export {
  type CreateRegistryConfig,
  createRulesRegistry,
  type RulesRegistry,
} from './registry'

// R1 — schema + types
export {
  AGGREGATIONS,
  BASELINE_PERCENTILES,
  COMPARES,
  RAW_SQL_SETTING_TYPES,
  RawSqlSettingSchema,
  rawSqlSettingType,
  RuleSchema,
  RuleValidationError,
  SEVERITIES,
  TargetSchema,
  ThrottleSchema,
  WINDOWS,
} from './schema'

export type {
  Aggregation,
  BaselinePercentile,
  Compare,
  RawSqlSetting,
  RawSqlSettingType,
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
export { allowedWindowsFor, validateRule } from './validator'
