/**
 * Public type surface for @mongrov/analytics/tools.
 *
 * Types shared across tool impls, rate limiter, authorize hooks,
 * audit writer, wrapper, and the top-level factory.
 */

import type { AnalyticsEngine, FamilyMembersProvider } from '../core/types'

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
 * result. `makeTool` (T-10) wraps this with rate → auth → execute →
 * budget → audit chain to produce an AI SDK `tool()` handle.
 */
export type ToolImpl<Input> = (
  input: Input,
  ctx: ToolContext & { analytics: AnalyticsEngine },
) => Promise<ToolResult>

/**
 * Outcome recorded in `tool_call_audit.outcome`. Enum discipline —
 * every wrapper code path resolves to exactly one of these.
 */
export type ToolOutcome
  = | 'success'
    | 'rate_limited'
    | 'authorized_reject'
    | 'error'

/**
 * A single row destined for `tool_call_audit`. Column mapping (see
 * `core/schemas.ts` line 189):
 *   ts, brand, family_id, requester_user_id, tool_name, args,
 *   result_bytes, result_row_count, latency_ms, outcome, error_message
 */
export interface AuditEntry {
  readonly ts: Date
  readonly brand: string
  readonly familyId: string
  readonly requesterUserId: string
  readonly toolName: string
  readonly args: Record<string, unknown>
  readonly resultBytes: number | null
  readonly resultRowCount: number | null
  readonly latencyMs: number | null
  readonly outcome: ToolOutcome
  readonly errorMessage: string | null
}

/**
 * Batched writer for `tool_call_audit`. `record` is non-blocking —
 * entries flush on batch-size or timer. `flush` and `close` are test
 * hooks / graceful-shutdown hooks respectively.
 */
export interface AuditWriter {
  record: (entry: AuditEntry) => void
  flush: () => Promise<void>
  close: () => Promise<void>
}

/**
 * Per-tool output ceiling enforced by `applyOutputBudget`. Text
 * exceeding `maxBytes` is UTF-8-safely truncated with a
 * `\n[truncated]` suffix. `maxRows` is informational — impls limit
 * row count via SQL.
 */
export interface OutputBudget {
  maxBytes: number
  maxRows: number
}

export const DEFAULT_OUTPUT_BUDGET: OutputBudget = {
  maxBytes: 4096,
  maxRows: 100,
}

/**
 * Config for `createAnalyticsTools` factory. All fields except
 * `analytics` are optional with sane defaults from `spec.md`.
 *
 * - `rateLimit: false` disables the limiter entirely (tests only).
 * - `authorize: undefined` defaults to `familyScopeAuthorize` wired
 *   with `familyMembersProvider` if supplied.
 * - `audit.enabled: false` makes `record` a no-op.
 */
export interface AnalyticsToolsConfig {
  analytics: AnalyticsEngine
  authorize?: AuthorizeFn
  rateLimit?: RateLimitConfig | false
  audit?: {
    enabled?: boolean
    batchSize?: number
    flushIntervalMs?: number
    retentionDays?: number
  }
  outputBudget?: Partial<OutputBudget>
  logger?: ToolsLogger
  familyMembersProvider?: FamilyMembersProvider
  clock?: () => number
}
