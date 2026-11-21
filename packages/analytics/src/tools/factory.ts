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
 * `setContext(ctx)`. Consumers (the app) call `setContext` before
 * each LLM turn — matching how `@mongrov/ai`'s `AIProvider` threads
 * per-request scopes. This design keeps rate-limiter buckets + audit
 * writer state shared across requests rather than rebuilding the
 * whole tool map per turn.
 */

import type { PackTool } from '../core/packs'
import type { RateLimiter } from './rate-limit'

import type {
  AnalyticsToolsConfig,
  AuditWriter,
  OutputBudget,
  ToolContext,
} from './types'
import { AnalyticsError } from '../core/errors'
import { packExtensions } from '../core/packs'
import { createAuditWriter } from './audit'
import { familyScopeAuthorize } from './authorize'
import { createRateLimiter } from './rate-limit'
import {
  DEFAULT_OUTPUT_BUDGET,
  DEFAULT_RATE_LIMIT,
} from './types'
import { makeTool } from './wrap'

/** Every registered pack's wrapped tools, by name. */
export type AnalyticsToolMap = Record<string, ReturnType<typeof makeTool<any>>>

export interface AnalyticsToolsHandle {
  tools: AnalyticsToolMap
  /**
   * Wrap a host's own tool in the same chain as the pack tools: argument
   * validation, the shared rate limiter, authorization, every pack's copy
   * guard, the output budget and the same audit writer, under the context
   * set by `setContext`. For tools a host builds from its own code (they
   * need something a pack cannot reach), so the model's every tool runs
   * through one safety layer. The tool is returned, not added to `tools`.
   * Throws `invalid_config` for a name a pack tool already uses: the two
   * would share rate-limit buckets and be indistinguishable in the audit.
   */
  wrap: (name: string, def: PackTool) => ReturnType<typeof makeTool<any>>
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
  // Names are unique across packs: `registerPack` rejects a collision.
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
    wrap(name, def) {
      if (Object.prototype.hasOwnProperty.call(tools, name))
        throw new AnalyticsError('invalid_config', `tool "${name}" is already a pack tool`)
      return makeTool({
        ...shared,
        name,
        description: def.description,
        inputSchema: def.inputSchema,
        impl: def.impl,
      })
    },
    setContext(ctx) {
      currentCtx = ctx
    },
    auditWriter: audit,
    async close() {
      await audit.close()
    },
  }
}
