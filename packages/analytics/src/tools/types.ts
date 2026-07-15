/**
 * Public type surface for @mongrov/analytics/tools.
 *
 * Types shared across tool impls, rate limiter, and authorize hooks.
 * The AI SDK `tool()` binding, `makeTool` wrapper, audit writer, and
 * `createAnalyticsTools` factory land in a follow-up cut
 * (T-09..T-11). Impls in this cut return `ToolResult` directly.
 */

import type { AnalyticsEngine } from '../core/types'

/** Runtime context threaded through every tool impl and authorize hook. */
export interface ToolContext {
  readonly requesterUserId: string
  readonly brand: string
  readonly familyId: string
  readonly now?: () => Date
}

/** Bounded text summary returned by every tool impl. */
export interface ToolResult {
  readonly text: string
  readonly rowCount: number
  readonly bytes: number
}

/**
 * Authorization hook — invoked before every tool execute. `false`
 * rejects the call before SQL runs. Toolname passes through so hooks
 * can gate by tool identity in addition to args + ctx.
 */
export type AuthorizeFn = (
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<boolean>

/**
 * Token-bucket rate-limit ceilings. Defaults come from
 * `analytics-ai-tools/spec.md` §Rate limiting.
 */
export interface RateLimitConfig {
  perToolPerMinute: number
  perToolPerHour: number
  perUserPerMinute: number
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  perToolPerMinute: 20,
  perToolPerHour: 200,
  perUserPerMinute: 60,
}

export interface ToolsLogger {
  debug: (message: string, meta?: Record<string, unknown>) => void
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
  error: (message: string, meta?: Record<string, unknown>) => void
}

/**
 * A tool impl. Takes a Zod-parsed input and the runtime context
 * (augmented with the analytics engine), returns a bounded text
 * result. `makeTool` (T-10) will wrap this with rate → auth → audit
 * chain to produce an AI SDK `tool()` handle.
 */
export type ToolImpl<Input> = (
  input: Input,
  ctx: ToolContext & { analytics: AnalyticsEngine },
) => Promise<ToolResult>
