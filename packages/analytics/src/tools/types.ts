/**
 * Public type surface for @mongrov/analytics/tools.
 *
 * Types shared across tool impls, rate limiter, authorize hooks,
 * audit writer, wrapper, and the top-level factory.
 */

import type { AnalyticsEngine, AnalyticsLogger, FamilyMembersProvider } from '../core/types'
import type { ToolOutcome } from './outcome'
import type { ToolRenderConfig } from './render'

/** Runtime context threaded through every tool impl and authorize hook. */
export interface ToolContext {
  readonly requesterUserId: string
  readonly brand: string
  readonly familyId: string
  readonly now?: () => Date
  /**
   * The user's IANA zone. Days in tool output are this zone's days, so they
   * match the screens. Omitted means UTC — correct only for a UTC user, which
   * is why the app passes it.
   */
  readonly timezone?: string
}

/**
 * Bounded text summary returned by a tool impl.
 *
 * Superseded in 0.62.0 for new tools: return a `ToolOutcome` from a
 * `defineTool` impl instead. Impls returning `ToolResult` keep working
 * unchanged (the compatibility path); the type is removed only once every
 * pack has moved to the envelope. (Not tagged `@deprecated`, so a consumer's
 * deprecation lint does not fail on the packs still using it.)
 */
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

/** The package's one logger shape; the name is kept for existing imports. */
export type ToolsLogger = AnalyticsLogger

/**
 * A tool impl. Takes a Zod-parsed input and the runtime context
 * (augmented with the analytics engine), returns a bounded text
 * result. `makeTool` (T-10) wraps this with rate → auth → execute →
 * budget → audit chain to produce an AI SDK `tool()` handle.
 */
export type ToolImpl<Input> = (
  input: Input,
  /** `logger` is the tools logger, for failures an impl degrades past. */
  ctx: ToolContext & { analytics: AnalyticsEngine, logger?: ToolsLogger },
) => Promise<ToolResult>

/**
 * Outcome recorded in `tool_call_audit.outcome`. Enum discipline —
 * every wrapper code path resolves to exactly one of these.
 *
 * Renamed from `ToolOutcome` in 0.62.0, which now names the result envelope.
 * `invalid_args` (before 0.62.0 folded into `error`) and `call_limit` are new.
 */
export type AuditOutcome
  = | 'success'
    | 'invalid_args'
    | 'call_limit'
    | 'rate_limited'
    | 'authorized_reject'
    | 'error'

/**
 * A single row destined for `tool_call_audit`. Column mapping (see
 * `core/platform-tables.ts`):
 *   ts, brand, family_id, requester_user_id, tool_name, args,
 *   result_bytes, result_row_count, latency_ms, outcome, error_message,
 *   and since 0.62.0 (platform migration 3, all nullable):
 *   result_status, error_code, result_digest, render_chars,
 *   truncated_items, turn_id, call_index, cached
 *
 * No result content is stored: `resultDigest` is a 16-hex FNV-1a-64 of the
 * text the model received, enough to tell two results apart, not to read one.
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
  readonly outcome: AuditOutcome
  readonly errorMessage: string | null
  /** ok / empty / insufficient / error. */
  readonly resultStatus?: ToolOutcome['status'] | null
  /** The envelope's `error.code`, or null. */
  readonly errorCode?: string | null
  readonly resultDigest?: string | null
  /** Length of the text the model received. */
  readonly renderChars?: number | null
  /** Items the budget dropped (0 when none). */
  readonly truncatedItems?: number | null
  /** The answer this call belongs to (`handle.beginTurn`), or null. */
  readonly turnId?: string | null
  /** 1-based index of the call within its answer, or null. */
  readonly callIndex?: number | null
  /** A repeated call in the same answer, served from the answer's cache. */
  readonly cached?: boolean | null
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
 * exceeding `maxBytes` loses its oldest dated rows first; only text
 * that still does not fit is cut UTF-8-safely with a `\n[truncated]`
 * suffix. `maxRows` is informational — impls limit row count via SQL.
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
  /**
   * `maxBytes` / `maxRows`: the byte budget of `ToolResult` (compatibility)
   * text. `maxChars` (default 1200): the character budget of one structured
   * result; `turnChars` (default 3600): of every structured result in one
   * answer together.
   */
  outputBudget?: Partial<OutputBudget & { maxChars: number, turnChars: number }>
  /**
   * When a structured result breaks the envelope rules or its `outputSchema`:
   * `'throw'` fails the call loudly (the default under a test runner, so a bad
   * fixture fails its test), `'error_outcome'` returns `error/output_invalid`
   * to the model (the default everywhere else: a throw would end an on-device
   * model's whole generation).
   */
  outputValidation?: 'throw' | 'error_outcome'
  /** Renderer choice for every structured tool (see `renderers`). */
  render?: ToolRenderConfig
  /**
   * Calls allowed in one answer (`handle.beginTurn`). Default
   * `{ perTurn: 4, dedupe: true }`: the 5th call is refused `call_limit`, and
   * a repeat of the same tool with the same arguments is answered from the
   * answer's cache and not counted. `false` turns both off. No answer, no cap.
   */
  callLimit?: { perTurn: number, dedupe?: boolean } | false
  /** Called once per call, after its audit record, for every terminal state. */
  onResult?: (event: ToolResultEvent) => void
  logger?: ToolsLogger
  familyMembersProvider?: FamilyMembersProvider
  clock?: () => number
}

/** One finished call, as `onResult` listeners see it. */
export interface ToolResultEvent {
  readonly toolName: string
  readonly source: 'ai' | 'mcp'
  readonly turnId: string | null
  readonly callIndex: number | null
  /** Validated args, host-supplied ones included (or the raw args of a refused call). */
  readonly args: Readonly<Record<string, unknown>>
  /** Deep-frozen copy, so a listener cannot change what was audited. */
  readonly outcome: ToolOutcome<unknown>
  /** Exactly the string the model received. */
  readonly rendered: string
  /** The tool returned a `ToolResult` (compatibility path); `outcome.data` is null. */
  readonly legacy: boolean
  readonly cached: boolean
  readonly latencyMs: number
  readonly auditOutcome: AuditOutcome
}
