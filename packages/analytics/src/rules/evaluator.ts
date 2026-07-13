/**
 * Rule evaluator — glues registry + compiler cache + throttle + emitter to
 * `analytics.execute`.
 *
 * Two entry points:
 *   - `evaluateOnBatch(batch)` — called by sync after a successful flush.
 *     Considers only rules whose metric table intersects `batch.affectedTables`.
 *   - `evaluateScheduled()` — called by the sync scheduler cadence. Considers
 *     every active brand-matching rule, fanned out over family members.
 *
 * Both funnel through `evaluateRule(rule, ctx)` which is the throttle-gated
 * single-user check. A returned `RuleViolation` is emitted synchronously via
 * the shared emitter and echoed to callers.
 *
 * `analytics.execute` throws are caught + logged; a failing rule never
 * blocks the rest of the pass.
 */

import { METRIC_METADATA, type MetricId } from '../core/metric_metadata'
import type { AnalyticsEngine } from '../core/types'
import type { CompilerCache } from './compiler-cache'
import type { createEmitter } from './emitter'
import type { RulesRegistry } from './registry'
import type { Rule } from './schema'
import type { createThrottleStore } from './throttle'
import type {
  Clock,
  RuleViolation,
  RulesLogger,
  SensorBatch,
} from './types'

export interface EvaluatorConfig {
  registry: RulesRegistry
  cache: CompilerCache
  throttle: ReturnType<typeof createThrottleStore>
  emitter: ReturnType<typeof createEmitter>
  analytics: AnalyticsEngine
  brand: string
  familyId: string
  familyMembersProvider: (ctx: {
    brand: string
    familyId: string
  }) => Promise<string[]>
  clock: Clock
  logger?: RulesLogger
}

interface EvaluationRow {
  observed_value: number
  threshold_value: number
}

export interface Evaluator {
  evaluateOnBatch(batch: SensorBatch): Promise<RuleViolation[]>
  evaluateScheduled(): Promise<RuleViolation[]>
}

export function createEvaluator(config: EvaluatorConfig): Evaluator {
  const {
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
  } = config

  async function evaluateRule(
    rule: Rule,
    ctx: { userId: string, familyId: string },
  ): Promise<RuleViolation | null> {
    const throttled = await throttle.isThrottled(rule.id, ctx.userId, rule.throttle)
    if (throttled) {
      logger?.debug('rules.evaluator: throttled', {
        ruleId: rule.id,
        userId: ctx.userId,
      })
      return null
    }

    let rows: EvaluationRow[]
    try {
      const compiled = cache.getCompiled(rule, registry.rev)
      const params = {
        userId: ctx.userId,
        brand,
        familyId: ctx.familyId,
        ...compiled.params,
      }
      rows = await analytics.execute<EvaluationRow>(compiled.sql, params)
    }
    catch (err) {
      logger?.error('rules.evaluator: execute failed', {
        ruleId: rule.id,
        userId: ctx.userId,
        err: (err as Error).message,
      })
      return null
    }

    if (rows.length === 0) {
      return null
    }

    const row = rows[0]
    const violation: RuleViolation = {
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      userId: ctx.userId,
      familyId: ctx.familyId,
      brand: rule.brand ?? brand,
      observedValue: Number(row.observed_value),
      thresholdValue: Number(row.threshold_value),
      observedAt: clock(),
      evidence: {
        metric: rule.metric,
        window: rule.window,
        aggregation: rule.aggregation,
        compare: rule.compare,
        target: rule.target,
      },
    }

    await throttle.recordFire(rule.id, ctx.userId)
    emitter.emit('violation', violation)
    return violation
  }

  function rulesForTables(
    rules: Rule[],
    affectedTables: SensorBatch['affectedTables'],
  ): Rule[] {
    const tableSet = new Set<string>(affectedTables)
    return rules.filter((r) => {
      const meta = METRIC_METADATA[r.metric as MetricId]
      return tableSet.has(meta.table)
    })
  }

  return {
    async evaluateOnBatch(batch) {
      const active = registry.getByBrand(brand)
      const relevant = rulesForTables(active, batch.affectedTables)
      if (relevant.length === 0 || batch.affectedUserIds.length === 0) {
        return []
      }
      const violations: RuleViolation[] = []
      for (const rule of relevant) {
        for (const userId of batch.affectedUserIds) {
          const v = await evaluateRule(rule, { userId, familyId })
          if (v) violations.push(v)
        }
      }
      return violations
    },

    async evaluateScheduled() {
      const active = registry.getByBrand(brand)
      if (active.length === 0) {
        return []
      }
      let members: string[]
      try {
        members = await familyMembersProvider({ brand, familyId })
      }
      catch (err) {
        logger?.error('rules.evaluator: familyMembersProvider failed', {
          familyId,
          err: (err as Error).message,
        })
        return []
      }
      const violations: RuleViolation[] = []
      for (const rule of active) {
        for (const userId of members) {
          const v = await evaluateRule(rule, { userId, familyId })
          if (v) violations.push(v)
        }
      }
      return violations
    },
  }
}
