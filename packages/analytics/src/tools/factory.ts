/**
 * `createAnalyticsTools` — wrap every registered pack's AI tools
 * (`pack.tools`) into a single map ready to hand to
 * `streamText({ tools })` / `generateText`.
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

import type { PackTool } from '../core/packs'
import type { AnalyticsToolMap } from '../packs/health/tools'
import type { RateLimiter } from './rate-limit'

import type {
  AnalyticsToolsConfig,
  AuditWriter,
  OutputBudget,
  ToolContext,
} from './types'
import { packExtensions } from '../core/packs'
import { createAuditWriter } from './audit'
import { familyScopeAuthorize } from './authorize'
import { createRateLimiter } from './rate-limit'
import {
  DEFAULT_OUTPUT_BUDGET,
  DEFAULT_RATE_LIMIT,
} from './types'
import { makeTool } from './wrap'

export type { AnalyticsToolMap } from '../packs/health/tools'

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
        logger: config.logger,
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

  // Every registered pack's tools, in pack order (the platform's last).
  const tools = Object.fromEntries(
    packExtensions<Readonly<Record<string, PackTool>>>('tools')
      .flatMap(byName => Object.entries(byName))
      .map(([name, def]) => [name, makeTool({
        ...shared,
        name,
        description: def.description,
        inputSchema: def.inputSchema,
        impl: def.impl,
      })]),
  ) as unknown as AnalyticsToolMap

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
