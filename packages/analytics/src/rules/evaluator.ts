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
 * single-user check. A returned `RuleViolation` is (1) persisted to the
 * `insight` table, (2) emitted synchronously via the shared emitter, and
 * (3) echoed onto the app event bus (`threshold:violation` +
 * `insight:insert`) when one is configured — principle 35 fire-and-forget:
 * a failed insight INSERT is logged, never thrown into the eval loop, and
 * the private `'violation'` emission still happens.
 *
 * `analytics.execute` throws are caught + logged; a failing rule never
 * blocks the rest of the pass.
 */

import { nanoid } from 'nanoid'

import { METRIC_METADATA, type MetricId } from '../core/metric_metadata'
import { AnalyticsError } from '../core/errors'
import type { AnalyticsEngine, EventBus, KVStore } from '../core/types'
import { USER_SETTING_PARAM } from './compiler'
import type { CompilerCache } from './compiler-cache'
import type { CompiledRule } from './types'
import type { createEmitter } from './emitter'
import type { RulesRegistry } from './registry'
import type { Rule } from './schema'
import type { createThrottleStore } from './throttle'
import type {
  Clock,
  RuleViolation,
  RulesLogger,
  FlushSummary,
} from './types'

export interface EvaluatorConfig {
  registry: RulesRegistry
  /**
   * KVStore for `target.type: 'user_setting'` threshold resolution
   * (Sprint 5 T-23). Keys are `analytics:{userId}:{rule.target.key}`.
   */
  storage?: KVStore
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
  /** Optional app bus for `threshold:violation` / `insight:insert`. */
  eventBus?: EventBus
  logger?: RulesLogger
}

interface EvaluationRow {
  observed_value: number
  threshold_value: number
}

/**
 * Rule severity → insight severity. The rule schema keeps the historical
 * `'critical'` tier (TOML catalogs ship it); the `insight` table + registry
 * contract use `'urgent'` (spec §Table schema).
 */
const INSIGHT_SEVERITY: Record<Rule['severity'], 'info' | 'warn' | 'urgent'> = {
  info: 'info',
  warn: 'warn',
  critical: 'urgent',
}

export interface Evaluator {
  evaluateOnBatch(batch: FlushSummary): Promise<RuleViolation[]>
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
    eventBus,
    logger,
    storage,
  } = config

  /**
   * Per-eval-batch cache of resolved user settings. A batch may evaluate
   * the same (user, key) across several rules; re-reading MMKV each time
   * would be wasteful, and — worse — could resolve two different
   * thresholds within one pass if the user saved mid-batch.
   */
  let settingCache = new Map<string, number>()

  /**
   * T-23 — resolve a `user_setting` threshold at eval time.
   *
   * Falls back to the rule's `defaultValue` when the user has never set
   * one, or when the stored value is unusable. Never throws: a broken
   * setting must not silence the alert the user explicitly asked for — the
   * shipped default is the safer answer.
   */
  async function resolveUserSetting(
    userId: string,
    key: string,
    defaultValue: number,
    ruleId: string,
  ): Promise<number> {
    const cacheKey = `${userId} ${key}`
    const cached = settingCache.get(cacheKey)
    if (cached !== undefined) return cached

    let value = defaultValue
    let source = 'default'
    if (storage) {
      try {
        const stored = await storage.get<unknown>(`analytics:${userId}:${key}`)
        const parsed = typeof stored === 'string' ? Number(stored) : stored
        if (typeof parsed === 'number' && Number.isFinite(parsed)) {
          value = parsed
          source = 'kvstore'
        }
      }
      catch (err) {
        logger?.warn('rules.evaluator: user_setting read failed, using default', {
          ruleId,
          userId,
          key,
          err: (err as Error).message,
        })
      }
    }
    if (source === 'default') {
      logger?.debug('rules.evaluator: user_setting fallback to defaultValue', {
        ruleId, userId, key, defaultValue,
      })
    }
    settingCache.set(cacheKey, value)
    return value
  }

  /**
   * Persist a violation as an `insight` row (spec parent §23 / principle
   * 35). Returns the new insight_id, or null when the INSERT failed —
   * failure is logged and swallowed so evaluation always continues.
   * Unqualified `insight` resolves to the local catalog (insights are
   * local-first; the pusher syncs the table to R2).
   */
  async function persistInsight(rule: Rule, violation: RuleViolation): Promise<string | null> {
    const insightId = nanoid(24)
    try {
      await analytics.execute(
        `INSERT INTO insight (insight_id, ts, brand, family_id, user_id, rule_id, `
        + `metric, kind, severity, title, body, evidence, acknowledged_at, dismissed_at) `
        + `VALUES ($insightId, CAST($ts AS TIMESTAMP), $brand, $familyId, $userId, $ruleId, `
        + `$metric, 'threshold', $severity, $title, $body, $evidence, NULL, NULL)`,
        {
          insightId,
          ts: violation.observedAt.toISOString(),
          brand: violation.brand,
          familyId: violation.familyId,
          userId: violation.userId,
          ruleId: rule.id,
          metric: rule.metric,
          severity: INSIGHT_SEVERITY[rule.severity],
          title: rule.name,
          body: rule.description ?? null,
          evidence: JSON.stringify({
            ...violation.evidence,
            observedValue: violation.observedValue,
            thresholdValue: violation.thresholdValue,
          }),
        },
      )
      return insightId
    }
    catch (err) {
      logger?.error('rules.evaluator: insight insert failed', {
        ruleId: rule.id,
        userId: violation.userId,
        err: (err as Error).message,
      })
      return null
    }
  }

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
    // Hoisted so the violation's evidence can report which threshold
    // actually applied.
    let compiled: CompiledRule | undefined
    let params: Record<string, unknown> = {}
    try {
      compiled = cache.getCompiled(rule, registry.rev)
      params = {
        userId: ctx.userId,
        brand,
        familyId: ctx.familyId,
        ...compiled.params,
      }
      if (compiled.userSettingKey !== undefined) {
        params[USER_SETTING_PARAM] = await resolveUserSetting(
          ctx.userId,
          compiled.userSettingKey,
          compiled.userSettingDefault ?? 0,
          rule.id,
        )
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
        context: rule.context,
        consecutive: rule.consecutive,
        target: rule.target,
        // T-23: which threshold actually applied, and where it came from.
        // Without this a support ticket about "the alert fired at the
        // wrong number" is unanswerable.
        settingsUsed: compiled?.userSettingKey === undefined
          ? undefined
          : { key: compiled.userSettingKey, value: params[USER_SETTING_PARAM] },
      },
    }

    await throttle.recordFire(rule.id, ctx.userId)
    const insightId = await persistInsight(rule, violation)
    emitter.emit('violation', violation)
    if (eventBus) {
      // Bus handlers are app code — a throwing subscriber must not take
      // down the eval loop (fire-and-forget, principle 35).
      try {
        eventBus.emit('threshold:violation', {
          ruleId: rule.id,
          userId: ctx.userId,
          metric: rule.metric,
          severity: INSIGHT_SEVERITY[rule.severity],
          insightId,
          observedValue: violation.observedValue,
          thresholdValue: violation.thresholdValue,
        })
        // `insight:insert` means "a row landed" — skip it when the INSERT failed.
        if (insightId) {
          eventBus.emit('insight:insert', {
            insightId,
            userId: ctx.userId,
            metric: rule.metric,
          })
        }
      }
      catch (err) {
        logger?.error('rules.evaluator: event bus emit threw', {
          ruleId: rule.id,
          err: (err as Error).message,
        })
      }
    }
    return violation
  }

  function rulesForTables(
    rules: Rule[],
    affectedTables: FlushSummary['affectedTables'],
  ): Rule[] {
    const tableSet = new Set<string>(affectedTables)
    return rules.filter((r) => {
      const meta = METRIC_METADATA[r.metric as MetricId]
      return tableSet.has(meta.table)
    })
  }

  return {
    async evaluateOnBatch(batch) {
      settingCache = new Map()
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
      settingCache = new Map()
      if (analytics.state !== 'attached') {
        throw new AnalyticsError(
          'not_attached',
          `evaluateScheduled requires an attached analytics engine (state=${analytics.state})`,
        )
      }
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
