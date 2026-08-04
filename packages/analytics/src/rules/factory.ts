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
    eventBus,
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
    eventBus,
    logger,
    // Sprint 5 T-23 — same KVStore the throttle uses; user_setting
    // thresholds live under `analytics:{userId}:{key}`.
    storage,
  })

  let closed = false

  return {
    register: (rules) => registry.register(rules),
    replace: (rules) => registry.replace(rules),
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
    evaluateOnBatch: async (batch) => {
      if (closed) return []
      return evaluator.evaluateOnBatch(batch)
    },
    evaluateScheduled: async () => {
      if (closed) return []
      return evaluator.evaluateScheduled()
    },
    on: (event, handler) => {
      if (closed) return () => {}
      return emitter.on(event, handler)
    },
    subscribeRegistry: (listener) => {
      if (closed) return () => {}
      return registry.subscribe(listener)
    },
    async close() {
      if (closed) return
      closed = true
      emitter.close()
      registry.close()
    },
  }
}
