/**
 * `createRulesEngine(config)` — assembles registry, compiler cache,
 * throttle store, emitter, and evaluator into the public `RulesEngine`
 * surface.
 *
 * The factory holds no persistent state of its own; all state lives on
 * the sub-modules. Callers pass a `KVStore` for durable state (rule
 * enable flags, throttle counters) and an `AnalyticsEngine` for SQL
 * execution.
 */

import { createCompilerCache } from './compiler-cache'
import { createEmitter } from './emitter'
import { createEvaluator } from './evaluator'
import { createRulesRegistry } from './registry'
import { createThrottleStore } from './throttle'
import type { RulesEngine, RulesEngineConfig } from './types'

export function createRulesEngine(config: RulesEngineConfig): RulesEngine {
  const {
    analytics,
    storage,
    familyMembersProvider,
    brand,
    familyId,
    logger,
    clock = () => new Date(),
  } = config

  const emitter = createEmitter({ logger })
  const throttle = createThrottleStore({ storage, clock, logger })
  const cache = createCompilerCache()
  const registry = createRulesRegistry({
    storage,
    logger,
    defaultBrand: brand,
  })
  const evaluator = createEvaluator({
    registry,
    cache,
    throttle,
    emitter,
    analytics,
    brand,
    familyId,
    familyMembersProvider,
    clock,
    logger,
  })

  return {
    register: (rules) => registry.register(rules),
    enable: (ruleId) => {
      cache.invalidate(ruleId)
      return registry.enable(ruleId)
    },
    disable: (ruleId) => {
      cache.invalidate(ruleId)
      return registry.disable(ruleId)
    },
    list: () => registry.list(),
    getActive: () => registry.getActive(),
    evaluateOnBatch: (batch) => evaluator.evaluateOnBatch(batch),
    evaluateScheduled: () => evaluator.evaluateScheduled(),
    on: (event, handler) => emitter.on(event, handler),
    subscribeRegistry: (listener) => registry.subscribe(listener),
  }
}
