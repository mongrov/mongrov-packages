/**
 * In-memory rule registry with KV-persisted `enabled` state.
 *
 * Every register/enable/disable bumps `rev` — the compiler cache keys on
 * `(ruleId, rev)`, so mutations transparently invalidate compiled SQL.
 *
 * The `subscribe(listener)` surface backs the `useRuleRegistry` hook via
 * `useSyncExternalStore`.
 */

import type { MetricId } from '../core/metric_metadata'
import type { KVStore, Unsubscribe } from '../core/types'
import type { Rule } from './schema'
import type { RulesLogger } from './types'
import { describeError } from '../core/errors'
import { RuleSchema, RuleValidationError } from './schema'
import { validateRule } from './validator'

const KV_ENABLED_PREFIX = 'analytics:rules:'

function enabledKey(ruleId: string): string {
  return `${KV_ENABLED_PREFIX}${ruleId}:enabled`
}

export interface RulesRegistry {
  register: (rules: Rule[]) => Promise<void>
  /**
   * Atomically swap the entire rule set: clears existing entries, validates
   * every incoming rule, rehydrates each rule's `enabled` state from KV,
   * bumps `rev` once, and notifies subscribers exactly once.
   */
  replace: (rules: Rule[]) => Promise<void>
  enable: (ruleId: string) => Promise<void>
  disable: (ruleId: string) => Promise<void>
  list: () => Rule[]
  getActive: () => Rule[]
  getByMetric: (metric: MetricId) => Rule[]
  getByBrand: (brand: string) => Rule[]
  subscribe: (listener: () => void) => Unsubscribe
  readonly rev: number
  /** Drop every subscribed listener. Idempotent. Used by `RulesEngine.close()`. */
  close: () => void
}

export interface CreateRegistryConfig {
  storage: KVStore
  logger?: RulesLogger
  /** Brand assigned to rules with no explicit `brand` field. Default `ziva`. */
  defaultBrand?: string
}

export function createRulesRegistry({
  storage,
  logger,
  defaultBrand = 'ziva',
}: CreateRegistryConfig): RulesRegistry {
  const entries = new Map<string, { rule: Rule, enabled: boolean }>()
  const listeners = new Set<() => void>()
  let rev = 0

  function notify(): void {
    rev += 1
    for (const listener of listeners) {
      try {
        listener()
      }
      catch (err) {
        logger?.error('rules.registry: listener threw', {
          err: describeError(err),
        })
      }
    }
  }

  return {
    async register(rules) {
      // Validate everything up-front — fail fast on first bad rule.
      const validated: Rule[] = []
      for (const raw of rules) {
        const parsed = RuleSchema.parse(raw)
        validateRule(parsed, logger)
        validated.push(parsed)
      }

      for (const rule of validated) {
        const persisted = await storage.get<boolean>(enabledKey(rule.id))
        entries.set(rule.id, {
          rule,
          enabled: persisted ?? true,
        })
      }
      logger?.info('rules.registry: registered', { count: validated.length })
      notify()
    },

    async replace(rules) {
      // Validate everything up-front — fail fast leaves the current set intact.
      const validated: Rule[] = []
      for (const raw of rules) {
        const parsed = RuleSchema.parse(raw)
        validateRule(parsed, logger)
        validated.push(parsed)
      }

      entries.clear()
      for (const rule of validated) {
        const persisted = await storage.get<boolean>(enabledKey(rule.id))
        entries.set(rule.id, {
          rule,
          enabled: persisted ?? true,
        })
      }
      logger?.info('rules.registry: replaced', { count: validated.length })
      notify()
    },

    async enable(ruleId) {
      const entry = entries.get(ruleId)
      if (!entry) {
        throw new RuleValidationError(`Rule ${ruleId} not registered.`)
      }
      entry.enabled = true
      await storage.set(enabledKey(ruleId), true)
      notify()
    },

    async disable(ruleId) {
      const entry = entries.get(ruleId)
      if (!entry) {
        throw new RuleValidationError(`Rule ${ruleId} not registered.`)
      }
      entry.enabled = false
      await storage.set(enabledKey(ruleId), false)
      notify()
    },

    list() {
      return Array.from(entries.values()).map(e => e.rule)
    },

    getActive() {
      const active: Rule[] = []
      for (const entry of entries.values()) {
        if (entry.enabled)
          active.push(entry.rule)
      }
      return active
    },

    getByMetric(metric) {
      return this.getActive().filter(r => r.metric === metric)
    },

    getByBrand(brand) {
      return this.getActive().filter(r => (r.brand ?? defaultBrand) === brand)
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    get rev() {
      return rev
    },

    close() {
      listeners.clear()
    },
  }
}
