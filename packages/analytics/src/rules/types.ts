/**
 * Public runtime types for @mongrov/analytics/rules.
 *
 * Kept structural (no z.infer imports at value level) so downstream
 * consumers don't need to pull the Zod schema module unless they
 * validate rules themselves.
 */

import type {
  AnalyticsEngine,
  FamilyMembersProvider,
  KVStore,
  Unsubscribe,
} from '../core/types'
import type { MetricId } from '../core/metric_metadata'
import type { TableName } from '../core/schemas'
import type { Rule } from './schema'

export type { Unsubscribe }

/** Rule severity mirrors the `insight.severity` column. */
export type RuleSeverity = 'info' | 'warn' | 'critical'

/**
 * Subset of a flushed batch that the rules engine reads to gate work.
 * Sync produces this shape after a successful flush.
 *
 * Named `FlushSummary` to avoid collision with sync's own `SensorBatch`
 * (which is the pre-flush push envelope, not the post-flush summary).
 */
export interface FlushSummary {
  affectedUserIds: string[]
  affectedTables: TableName[]
}

/**
 * Compiled artifact for a rule. `sql` uses `$name` placeholders bound
 * via `analytics.execute(sql, params)`; identifiers are already inlined
 * as sanitized literals inside `sql`.
 */
export interface CompiledRule {
  ruleId: string
  metric: MetricId
  sql: string
  /** Statically-known params. Runtime binds `$userId`/`$brand`/`$familyId` on top. */
  params: Record<string, string | number>
  description: string
}

/** Structured violation delivered to `on('violation', handler)` subscribers. */
export interface RuleViolation {
  ruleId: string
  ruleName: string
  severity: RuleSeverity
  userId: string
  familyId: string
  brand: string
  observedValue: number
  thresholdValue: number
  observedAt: Date
  evidence: Record<string, unknown>
}

/** Structured logger (subset of AnalyticsLogger). */
export interface RulesLogger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

/** Injected by tests; production defaults to `new Date()`. */
export type Clock = () => Date

/** Config for `createRulesEngine`. */
export interface RulesEngineConfig {
  analytics: AnalyticsEngine
  storage: KVStore
  familyMembersProvider: FamilyMembersProvider
  brand: string
  /** Family id for `onSchedule` — v0.1.0 single-user apps pass the userId. */
  familyId: string
  logger?: RulesLogger
  clock?: Clock
}

/** Public rules engine surface. */
export interface RulesEngine {
  register(rules: Rule[]): Promise<void>
  enable(ruleId: string): Promise<void>
  disable(ruleId: string): Promise<void>
  list(): Rule[]
  getActive(): Rule[]
  evaluateOnBatch(batch: FlushSummary): Promise<RuleViolation[]>
  evaluateScheduled(): Promise<RuleViolation[]>
  on(event: 'violation', handler: (v: RuleViolation) => void): Unsubscribe
  /**
   * Subscribe to registry mutations (register / enable / disable). Backs the
   * `useRuleRegistry` hook via `useSyncExternalStore`.
   */
  subscribeRegistry(listener: () => void): Unsubscribe
}
