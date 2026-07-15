/**
 * `createAnalyticsTools` — assemble the 6 wrapped AI SDK tools into
 * a single map ready to hand to `streamText({ tools })` / `generateText`.
 *
 * Wires:
 *   - rate limiter   (or `null` if `rateLimit: false`)
 *   - authorize hook (default `familyScopeAuthorize`, optionally with
 *                     an injected `familyMembersProvider`)
 *   - audit writer   (batched, optional)
 *   - output budget  (default 4096 bytes / 100 rows)
 *
 * Per-request context threading: the AI SDK's `execute(input)` has no
 * ctx arg. We hold a mutable `currentCtx` container and expose
 * `setContext(ctx)`. Consumers (zivaone_app) call `setContext` before
 * each LLM turn — matching how `@mongrov/ai`'s `AIProvider` threads
 * per-request scopes. This design keeps rate-limiter buckets + audit
 * writer state shared across requests rather than rebuilding the
 * whole tool map per turn.
 */

import { createAuditWriter } from './audit'
import { familyScopeAuthorize } from './authorize'
import { createRateLimiter, type RateLimiter } from './rate-limit'
import {
  DEFAULT_OUTPUT_BUDGET,
  DEFAULT_RATE_LIMIT,
} from './types'
import type {
  AnalyticsToolsConfig,
  AuditWriter,
  OutputBudget,
  ToolContext,
} from './types'
import { makeTool } from './wrap'

import {
  getActivityTotal,
  getActivityTotalInputSchema,
  type GetActivityTotalInput,
} from './impls/activity'
import {
  detectAnomaly,
  detectAnomalyInputSchema,
  type DetectAnomalyInput,
} from './impls/anomaly'
import {
  compareTrend,
  compareTrendInputSchema,
  type CompareTrendInput,
} from './impls/compare'
import { getHRV, getHRVInputSchema, type GetHRVInput } from './impls/hrv'
import {
  getInsights,
  getInsightsInputSchema,
  type GetInsightsInput,
} from './impls/insights'
import {
  getSleepSummary,
  getSleepSummaryInputSchema,
  type GetSleepSummaryInput,
} from './impls/sleep'

const DESCRIPTIONS = {
  getHRV: 'Return the requester\'s or a family member\'s average HRV per day '
    + 'over the last N days (1..90). Args: userId, days.',
  getSleepSummary: 'Return nightly sleep duration and efficiency for a user '
    + 'over the last N days (1..30). Args: userId, days.',
  getActivityTotal: 'Return total steps and active minutes per day for a user '
    + 'over the last N days (1..30). Args: userId, days.',
  compareTrend: 'Compare a user\'s metric average across two windows. Args: '
    + 'userId, metric (hrv_ms|sleep_total_minutes|activity_steps), '
    + 'currentWindowDays, priorWindowDays (each 1..30).',
  detectAnomaly: 'Flag statistical outliers (>= stddevThreshold from baseline) '
    + 'in a user\'s metric over the last lookbackDays. Args: userId, metric '
    + '(hrv_ms|sleep_total_minutes|activity_steps), lookbackDays (7..90), '
    + 'stddevThreshold (1..4, default 2).',
  getInsights: 'Return recent AI-generated insights for a user. Args: userId, '
    + 'days (1..30, default 7), optional severity (info|warn|critical).',
} as const

export interface AnalyticsToolMap {
  getHRV: ReturnType<typeof makeTool<GetHRVInput>>
  getSleepSummary: ReturnType<typeof makeTool<GetSleepSummaryInput>>
  getActivityTotal: ReturnType<typeof makeTool<GetActivityTotalInput>>
  compareTrend: ReturnType<typeof makeTool<CompareTrendInput>>
  detectAnomaly: ReturnType<typeof makeTool<DetectAnomalyInput>>
  getInsights: ReturnType<typeof makeTool<GetInsightsInput>>
}

export interface AnalyticsToolsHandle {
  tools: AnalyticsToolMap
  setContext: (ctx: ToolContext | null) => void
  auditWriter: AuditWriter
  close: () => Promise<void>
}

export function createAnalyticsTools(
  config: AnalyticsToolsConfig,
): AnalyticsToolsHandle {
  const budget: OutputBudget = {
    ...DEFAULT_OUTPUT_BUDGET,
    ...(config.outputBudget ?? {}),
  }

  const rateLimiter: RateLimiter | null
    = config.rateLimit === false
      ? null
      : createRateLimiter({
          config: config.rateLimit ?? DEFAULT_RATE_LIMIT,
          clock: config.clock,
        })

  const authorize
    = config.authorize
    ?? familyScopeAuthorize(config.analytics, {
      familyMembersProvider: config.familyMembersProvider,
    })

  const audit = createAuditWriter({
    analytics: config.analytics,
    enabled: config.audit?.enabled ?? true,
    batchSize: config.audit?.batchSize,
    flushIntervalMs: config.audit?.flushIntervalMs,
    logger: config.logger,
  })

  let currentCtx: ToolContext | null = null
  const ctxProvider = (): ToolContext | null => currentCtx

  const shared = {
    analytics: config.analytics,
    authorize,
    rateLimiter,
    audit,
    budget,
    logger: config.logger,
    ctxProvider,
    clock: config.clock,
  }

  const tools: AnalyticsToolMap = {
    getHRV: makeTool({
      ...shared,
      name: 'getHRV',
      description: DESCRIPTIONS.getHRV,
      inputSchema: getHRVInputSchema,
      impl: getHRV,
    }),
    getSleepSummary: makeTool({
      ...shared,
      name: 'getSleepSummary',
      description: DESCRIPTIONS.getSleepSummary,
      inputSchema: getSleepSummaryInputSchema,
      impl: getSleepSummary,
    }),
    getActivityTotal: makeTool({
      ...shared,
      name: 'getActivityTotal',
      description: DESCRIPTIONS.getActivityTotal,
      inputSchema: getActivityTotalInputSchema,
      impl: getActivityTotal,
    }),
    compareTrend: makeTool({
      ...shared,
      name: 'compareTrend',
      description: DESCRIPTIONS.compareTrend,
      inputSchema: compareTrendInputSchema,
      impl: compareTrend,
    }),
    detectAnomaly: makeTool({
      ...shared,
      name: 'detectAnomaly',
      description: DESCRIPTIONS.detectAnomaly,
      inputSchema: detectAnomalyInputSchema,
      impl: detectAnomaly,
    }),
    getInsights: makeTool({
      ...shared,
      name: 'getInsights',
      description: DESCRIPTIONS.getInsights,
      inputSchema: getInsightsInputSchema,
      impl: getInsights,
    }),
  }

  return {
    tools,
    setContext(ctx) {
      currentCtx = ctx
    },
    auditWriter: audit,
    async close() {
      await audit.close()
    },
  }
}
