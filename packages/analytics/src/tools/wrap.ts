/**
 * `makeTool` — compose an AI SDK `tool()` from a raw impl plus the
 * rate → auth → execute → budget → audit chain.
 *
 * The chain order is load-bearing:
 *   1. Rate limit  → cheap, no I/O; short-circuits abusive callers.
 *   2. Authorize   → may hit SQL/provider; runs after rate cap.
 *   3. Execute     → real tool work.
 *   4. Budget      → truncate oversized text before returning.
 *   5. Audit       → record every terminal state (success / reject
 *                    / rate-limited / error).
 *
 * Every branch records exactly one audit entry. The wrapper never
 * throws — errors resolve to a short LLM-friendly string. Because
 * the AI SDK `execute(input)` signature has no per-call context arg,
 * the caller supplies a `ctxProvider()` closure that returns the
 * current `ToolContext` at invocation time (the factory backs this
 * with a mutable container updated per request).
 */

import { tool } from 'ai'
import type { ZodTypeAny } from 'zod'
import type { AnalyticsEngine } from '../core/types'
import { applyOutputBudget } from './budget'
import type { RateLimiter } from './rate-limit'
import type {
  AuditWriter,
  AuthorizeFn,
  OutputBudget,
  ToolContext,
  ToolImpl,
  ToolsLogger,
} from './types'

const RATE_LIMIT_MESSAGE = 'Rate limit exceeded. Try again shortly.'
const AUTHZ_MESSAGE = 'Not authorized to access that user\'s data.'
const ERROR_MESSAGE = 'Tool call failed.'
const NO_CONTEXT_MESSAGE = 'Tool call failed: request context not set.'

export interface MakeToolConfig<Input> {
  name: string
  description: string
  /**
   * Accepts any Zod schema whose parsed output is assignable to
   * `Input`. Widened to `ZodTypeAny` so schemas with `.default()` /
   * `.optional()` fields (whose input types include `undefined`)
   * still fit — the AI SDK's own `tool()` uses the same shape.
   */
  inputSchema: ZodTypeAny
  impl: ToolImpl<Input>
  analytics: AnalyticsEngine
  authorize?: AuthorizeFn
  rateLimiter?: RateLimiter | null
  audit: AuditWriter
  budget: OutputBudget
  logger?: ToolsLogger
  /**
   * Returns the current `ToolContext` at execute-time. The factory
   * backs this with a mutable container so a single tool handle
   * threads per-request scope. Returning `null` triggers a clean
   * error branch (no ctx → audit `error` outcome).
   */
  ctxProvider: () => ToolContext | null
  clock?: () => number
}

export function makeTool<Input>(cfg: MakeToolConfig<Input>) {
  const clock = cfg.clock ?? Date.now

  return tool({
    description: cfg.description,
    parameters: cfg.inputSchema,
    execute: async (input: Input): Promise<string> => {
      const startMs = clock()
      const ctx = cfg.ctxProvider()

      // 0. Ctx guard — audit as error, no rate/auth/execute performed.
      if (!ctx) {
        cfg.audit.record({
          ts: new Date(clock()),
          brand: '',
          familyId: '',
          requesterUserId: '',
          toolName: cfg.name,
          args: input as Record<string, unknown>,
          resultBytes: null,
          resultRowCount: null,
          latencyMs: clock() - startMs,
          outcome: 'error',
          errorMessage: 'context not set',
        })
        cfg.logger?.warn('tool invoked without context', { toolName: cfg.name })
        return NO_CONTEXT_MESSAGE
      }

      // 1. Rate limit.
      if (cfg.rateLimiter && !cfg.rateLimiter.check(cfg.name, ctx.requesterUserId)) {
        cfg.audit.record({
          ts: new Date(clock()),
          brand: ctx.brand,
          familyId: ctx.familyId,
          requesterUserId: ctx.requesterUserId,
          toolName: cfg.name,
          args: input as Record<string, unknown>,
          resultBytes: null,
          resultRowCount: null,
          latencyMs: clock() - startMs,
          outcome: 'rate_limited',
          errorMessage: null,
        })
        return RATE_LIMIT_MESSAGE
      }

      // 2. Authorize.
      if (cfg.authorize) {
        const ok = await cfg.authorize(
          cfg.name,
          input as Record<string, unknown>,
          ctx,
        )
        if (!ok) {
          cfg.audit.record({
            ts: new Date(clock()),
            brand: ctx.brand,
            familyId: ctx.familyId,
            requesterUserId: ctx.requesterUserId,
            toolName: cfg.name,
            args: input as Record<string, unknown>,
            resultBytes: null,
            resultRowCount: null,
            latencyMs: clock() - startMs,
            outcome: 'authorized_reject',
            errorMessage: null,
          })
          return AUTHZ_MESSAGE
        }
      }

      // 3. Execute + 4. Budget + 5. Audit success/error.
      try {
        const raw = await cfg.impl(input, {
          ...ctx,
          analytics: cfg.analytics,
        })
        const capped = applyOutputBudget(raw, cfg.budget)
        cfg.audit.record({
          ts: new Date(clock()),
          brand: ctx.brand,
          familyId: ctx.familyId,
          requesterUserId: ctx.requesterUserId,
          toolName: cfg.name,
          args: input as Record<string, unknown>,
          resultBytes: capped.bytes,
          resultRowCount: capped.rowCount,
          latencyMs: clock() - startMs,
          outcome: 'success',
          errorMessage: null,
        })
        return capped.text
      }
      catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        cfg.audit.record({
          ts: new Date(clock()),
          brand: ctx.brand,
          familyId: ctx.familyId,
          requesterUserId: ctx.requesterUserId,
          toolName: cfg.name,
          args: input as Record<string, unknown>,
          resultBytes: null,
          resultRowCount: null,
          latencyMs: clock() - startMs,
          outcome: 'error',
          errorMessage,
        })
        cfg.logger?.warn('tool execution failed', {
          toolName: cfg.name,
          err: errorMessage,
        })
        return ERROR_MESSAGE
      }
    },
  })
}
