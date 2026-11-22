/**
 * `makeTool` — compose an AI SDK `tool()` from an impl plus the framework's
 * one safety chain. The order is load-bearing:
 *
 *    0. Context     → no request context: refused `no_context`.
 *    1. Input check → parse the arguments with the tool's Zod schema, so
 *                     defaults apply and bounds hold whatever the caller
 *                     checked (no runtime on any path validates them first).
 *                     A repeat of an earlier call in the same answer is
 *                     answered here from the answer's cache, uncounted.
 *    2. Answer cap  → inside an answer (`handle.beginTurn`), the call is
 *                     counted; past `callLimit.perTurn` it is refused
 *                     `call_limit`. Calls with bad arguments count too, so a
 *                     model cannot loop on them; within the cap they are
 *                     refused `invalid_args` with a message naming what each
 *                     field accepts.
 *    3. Rate limit  → cheap, no I/O; short-circuits abusive callers.
 *    4. Authorize   → may hit SQL/provider; runs after the rate cap.
 *    5. Execute     → the impl. A throw is `internal`.
 *    6. Output check→ the envelope's rules, then `data` against the tool's
 *                     `outputSchema`: `output_invalid` (throws under a test
 *                     runner, so a bad fixture fails loudly).
 *    7. Copy guard  → every registered pack's `copyGuard` over every string
 *                     in the result: data leaves, guidance, the error message.
 *    8. Render      → one string, by the chosen renderer; guarded again.
 *    9. Budget      → whole list items dropped, oldest first, to fit
 *                     `min(maxChars, what the answer has left)`; then a cut.
 *   10. Audit       → one `tool_call_audit` row for every terminal state.
 *   11. onResult    → the structured result to the host's listeners.
 *   12. Return      → one string to the model.
 *
 * A tool whose impl returns `ToolResult` (`{ text, rowCount, bytes }`, the
 * compatibility path) skips 6–9: its text passes the copy guard and the byte
 * budget exactly as in 0.61.1, and refusals read as they did. The wrapper
 * never throws, except for 6 under a test runner (see `outputValidation`):
 * on device a throw would end the model's whole generation.
 */

import type { ZodTypeAny } from 'zod'
import type { AnalyticsEngine } from '../core/types'
import type { ToolAnnotations, ToolExecContext } from './define'
import type { ToolBudget } from './fit'
import type { ToolErrorCode, ToolOutcome } from './outcome'
import type { RateLimiter } from './rate-limit'
import type { ToolRenderConfig, ToolRenderer } from './render'
import type { CachedCall, CallLimitPolicy, TurnTracker } from './turns'
import type {
  AuditOutcome,
  AuditWriter,
  AuthorizeFn,
  OutputBudget,
  ToolContext,
  ToolImpl,
  ToolResult,
  ToolResultEvent,
  ToolsLogger,
} from './types'
import { jsonSchema, tool } from 'ai'
import { describeError } from '../core/errors'
import { packExtensions } from '../core/packs'
import { applyOutputBudget } from './budget'
import { fnv1a64 } from './digest'
import { DEFAULT_MAX_CHARS, DEFAULT_TURN_CHARS, fitOutcome, hardCut, MIN_TURN_CHARS } from './fit'
import { toJsonSchemaObject } from './json-schema'
import { checkEnvelope, errorOutcome, frozenCopy, isToolOutcome, stringLeaves } from './outcome'
import { pickRenderer, renderers } from './render'
import { isTestRuntime } from './runtime'
import { callKey } from './turns'
import { describeInvalidArgs } from './validate'

export { toJsonSchemaObject } from './json-schema'

const RATE_LIMIT_MESSAGE = 'Rate limit exceeded. Try again shortly.'
const AUTHZ_MESSAGE = 'Not authorized to access that user\'s data.'
const ERROR_MESSAGE = 'Tool call failed.'
const NO_CONTEXT_MESSAGE = 'Tool call failed: request context not set.'
const CALL_LIMIT_MESSAGE = 'The tool call limit for this question is reached.'
/** What the model reads when an answer's calls are spent (a compatibility tool gets exactly this text). */
export const CALL_LIMIT_GUIDANCE = 'No more tool calls for this question. Answer now with what you already have.'
/** What the model reads when a result could not be trusted (output_invalid, copy_guard, internal). */
export const UNREADABLE_GUIDANCE = 'Say the data could not be read right now; do not give any value.'

/**
 * How one call ended — what `tool_call_audit.outcome` records.
 * Kept as the name 0.61.1 exported; the same union as `AuditOutcome`.
 */
export type ToolCallResult = AuditOutcome

/** @internal Everything about one finished call, keyed by the options object handed to `execute`. */
export interface ToolCallRecord {
  readonly result: AuditOutcome
  readonly outcome: ToolOutcome<unknown>
  readonly rendered: string
  readonly legacy: boolean
}

const callRecords = new WeakMap<object, ToolCallRecord>()

/** @internal How the call made with `options` ended; `undefined` if it never ran. */
export function toolCallResult(options: object): AuditOutcome | undefined {
  return callRecords.get(options)?.result
}

/** @internal The call made with `options`: its envelope and the text the model got. */
export function toolCallRecord(options: object): ToolCallRecord | undefined {
  return callRecords.get(options)
}

const mcpCalls = new WeakSet<object>()

/** @internal Mark an options object as an MCP call (no answer turn; `source: 'mcp'`). */
export function markMcpCall(options: object): void {
  mcpCalls.add(options)
}

/** @internal What the MCP adapter needs to list a wrapped tool. */
export interface ToolMeta {
  readonly title?: string
  readonly inputSchema: Record<string, unknown>
  readonly outputSchema?: ZodTypeAny
  readonly annotations?: ToolAnnotations
}

const toolMetas = new WeakMap<object, ToolMeta>()

/** @internal The definition behind a tool `makeTool` built. */
export function toolMeta(t: object): ToolMeta | undefined {
  return toolMetas.get(t)
}

/** Thrown (under a test runner, or with `outputValidation: 'throw'`) when a result fails its checks. */
export class ToolOutputError extends Error {
  constructor(toolName: string, readonly problems: readonly string[]) {
    super(`tool "${toolName}" returned an invalid result: ${problems.join('; ')}`)
    this.name = 'ToolOutputError'
  }
}

/** A structured impl: returns the envelope, or a `ToolResult` (compatibility). */
export type StructuredToolImpl<Input> = (
  input: Input,
  ctx: ToolExecContext,
) => Promise<ToolOutcome<unknown> | ToolResult>

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
  impl: ToolImpl<Input> | StructuredToolImpl<Input>
  analytics: AnalyticsEngine
  authorize?: AuthorizeFn
  rateLimiter?: RateLimiter | null
  audit: AuditWriter
  /** Byte budget of `ToolResult` text. */
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
  // ---- structured tools (0.62.0); all optional ----
  title?: string
  /** Schema of `ToolOutcome.data`. A tool without one runs on the compatibility path. */
  outputSchema?: ZodTypeAny
  render?: ToolRenderer<any>
  toolBudget?: ToolBudget
  annotations?: ToolAnnotations
  renderConfig?: ToolRenderConfig
  /** Default character budget of one result (`toolBudget.maxChars` wins). Default 1200. */
  maxChars?: number
  /** Character budget of one answer's results together. Default 3600. */
  turnChars?: number
  outputValidation?: 'throw' | 'error_outcome'
  turns?: TurnTracker
  callLimit?: CallLimitPolicy
  /** Called after the audit record of every call. A throw is caught and logged. */
  emit?: (event: ToolResultEvent) => void
}

/** What `finish` needs about a call's end. */
interface Ending {
  result: AuditOutcome
  text: string
  outcome: ToolOutcome<unknown>
  legacy: boolean
  cached?: boolean
  resultBytes?: number | null
  resultRowCount?: number | null
  errorMessage?: string | null
  truncatedItems?: number | null
}

const AUDIT_FOR_CODE: Readonly<Record<ToolErrorCode, AuditOutcome>> = Object.freeze({
  invalid_args: 'invalid_args',
  call_limit: 'call_limit',
  rate_limited: 'rate_limited',
  not_authorized: 'authorized_reject',
  no_context: 'error',
  output_invalid: 'error',
  copy_guard: 'error',
  internal: 'error',
})

/** Codes that count as a refusal in a turn's summary (the call never ran, or ran with bad arguments). */
const REFUSALS = new Set<ToolErrorCode>(['invalid_args', 'call_limit', 'rate_limited', 'not_authorized', 'no_context'])

const encoder = new TextEncoder()
const byteLength = (t: string): number => encoder.encode(t).byteLength

function getPath(data: unknown, path: string): unknown {
  let cur: unknown = data
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object')
      return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** Paths and rules of a Zod failure, never the values (the audit stores this). */
function describeIssues(issues: readonly { path: readonly PropertyKey[], code?: string, expected?: unknown }[]): string[] {
  return issues.slice(0, 8).map((i) => {
    const path = ['data', ...i.path.map(String)].join('.')
    const expected = typeof i.expected === 'string' ? ` (expected ${i.expected})` : ''
    return `${path}: ${i.code ?? 'invalid'}${expected}`
  })
}

export function makeTool<Input>(cfg: MakeToolConfig<Input>) {
  const clock = cfg.clock ?? Date.now
  const parameters = toJsonSchemaObject(cfg.inputSchema)
  const structured = cfg.outputSchema !== undefined
  const maxChars = cfg.toolBudget?.maxChars ?? cfg.maxChars ?? DEFAULT_MAX_CHARS
  const turnChars = cfg.turnChars ?? DEFAULT_TURN_CHARS
  const perTurn = cfg.callLimit?.perTurn ?? null
  const dedupe = cfg.callLimit?.dedupe ?? false
  const guards = (): ((text: string, source: string) => void)[] =>
    packExtensions<(text: string, source: string) => void>('copyGuard')

  const t = tool({
    description: cfg.description,
    parameters: jsonSchema(parameters as never),
    execute: async (rawInput: unknown, options?: unknown): Promise<string> => {
      const startMs = clock()
      const opts = options !== null && typeof options === 'object' ? options : null
      const source: 'ai' | 'mcp' = opts && mcpCalls.has(opts) ? 'mcp' : 'ai'
      const ctx = cfg.ctxProvider()
      // MCP calls never join the app's answer: a dev client must not spend it.
      const turn = source === 'ai' ? (cfg.turns?.current() ?? null) : null
      const callIndex = turn ? ++turn.calls : null
      const now = (): Date => (ctx?.now ? ctx.now() : new Date(clock()))
      let args = (rawInput ?? {}) as Record<string, unknown>

      const finish = (end: Ending): string => {
        const latencyMs = clock() - startMs
        cfg.audit.record({
          ts: new Date(clock()),
          brand: ctx?.brand ?? '',
          familyId: ctx?.familyId ?? '',
          requesterUserId: ctx?.requesterUserId ?? '',
          toolName: cfg.name,
          args,
          resultBytes: end.resultBytes ?? null,
          resultRowCount: end.resultRowCount ?? null,
          latencyMs,
          outcome: end.result,
          errorMessage: end.errorMessage ?? null,
          resultStatus: end.outcome.status,
          errorCode: end.outcome.error?.code ?? null,
          resultDigest: fnv1a64(end.text),
          renderChars: end.text.length,
          truncatedItems: end.truncatedItems ?? null,
          turnId: turn?.id ?? null,
          callIndex,
          cached: end.cached ?? false,
        })
        const frozen = frozenCopy(end.outcome)
        if (opts)
          callRecords.set(opts, { result: end.result, outcome: frozen, rendered: end.text, legacy: end.legacy })
        if (turn)
          turn.chars += end.text.length
        if (cfg.emit) {
          try {
            cfg.emit({
              toolName: cfg.name,
              source,
              turnId: turn?.id ?? null,
              callIndex,
              args: frozenCopy(args),
              outcome: frozen,
              rendered: end.text,
              legacy: end.legacy,
              cached: end.cached ?? false,
              latencyMs,
              auditOutcome: end.result,
            })
          }
          catch (err) {
            cfg.logger?.warn('tool onResult listener threw', { toolName: cfg.name, err: describeError(err) })
          }
        }
        return end.text
      }

      /** A refusal or failure the framework writes. */
      const refuse = (
        code: ToolErrorCode,
        message: string,
        legacyText: string,
        errorMessage: string | null = null,
        guidance: readonly string[] = [],
        fieldErrors?: Record<string, string>,
      ): string => {
        const o = errorOutcome(code, message, guidance, fieldErrors)
        if (turn && REFUSALS.has(code))
          turn.refused += 1
        let text = legacyText
        if (structured) {
          // A renderer whose output was just refused (or that threw) does not
          // print its own failure: the framework's `lines` does.
          const renderer = code === 'copy_guard' || code === 'internal'
            ? renderers.lines
            : pickRenderer(cfg.name, cfg.render, cfg.renderConfig)
          try {
            text = renderer(o, { toolName: cfg.name, maxChars, now: now() })
          }
          catch {
            // expected: a renderer that cannot print an error falls back to the plain message.
            text = message
          }
        }
        return finish({ result: AUDIT_FOR_CODE[code], text, outcome: o, legacy: !structured, errorMessage })
      }

      // 0. Context.
      if (!ctx) {
        cfg.logger?.warn('tool invoked without context', { toolName: cfg.name })
        return refuse('no_context', NO_CONTEXT_MESSAGE, NO_CONTEXT_MESSAGE, 'context not set')
      }

      // 1. Input check. No runtime validates before us: the AI SDK's
      // `jsonSchema()` has no validator, an on-device bridge parses with none
      // (and keeps only one numeric bound), and MCP passes arguments straight
      // through. Parsing applies `.default()`s and enforces every bound.
      const parsed = cfg.inputSchema.safeParse(rawInput ?? {})
      let key: string | null = null
      if (parsed.success) {
        args = parsed.data as Record<string, unknown>
        if (turn && dedupe) {
          key = callKey(cfg.name, args)
          const hit = turn.cache.get(key)
          if (hit) {
            return finish({
              result: hit.auditOutcome,
              text: hit.text,
              outcome: hit.outcome,
              legacy: hit.legacy,
              cached: true,
              resultBytes: hit.resultBytes,
              resultRowCount: hit.resultRowCount,
              truncatedItems: hit.truncatedItems,
            })
          }
        }
      }

      // 2. Answer cap: every uncached call counts, bad arguments included.
      if (turn && perTurn !== null) {
        turn.counted += 1
        if (turn.counted > perTurn) {
          cfg.logger?.warn('tool call limit reached', { toolName: cfg.name, turnId: turn.id, perTurn })
          return refuse('call_limit', CALL_LIMIT_MESSAGE, CALL_LIMIT_GUIDANCE, null, [CALL_LIMIT_GUIDANCE])
        }
      }

      if (!parsed.success) {
        const message = describeInvalidArgs(parsed.error, parameters, rawInput ?? {})
        cfg.logger?.warn('tool arguments rejected', { toolName: cfg.name, message })
        return refuse('invalid_args', message, message, message)
      }
      const input = parsed.data as Input

      // 3. Rate limit.
      if (cfg.rateLimiter && !cfg.rateLimiter.check(cfg.name, ctx.requesterUserId)) {
        cfg.logger?.warn('tool rate limited', { toolName: cfg.name })
        return refuse('rate_limited', RATE_LIMIT_MESSAGE, RATE_LIMIT_MESSAGE)
      }

      // 4. Authorize.
      if (cfg.authorize) {
        const ok = await cfg.authorize(cfg.name, args, ctx)
        if (!ok) {
          cfg.logger?.warn('tool authorization rejected', { toolName: cfg.name })
          return refuse('not_authorized', AUTHZ_MESSAGE, AUTHZ_MESSAGE)
        }
      }

      const remember = (end: Ending): string => {
        if (turn && key)
          turn.cache.set(key, cacheEntry(end))
        return finish(end)
      }

      // 5. Execute.
      let raw: ToolOutcome<unknown> | ToolResult
      try {
        const execCtx: ToolExecContext = {
          ...ctx,
          analytics: cfg.analytics,
          logger: cfg.logger,
          turn: turn ? { id: turn.id, callIndex: callIndex! } : null,
          now,
        }
        raw = await (cfg.impl as StructuredToolImpl<Input>)(input, execCtx)
      }
      catch (err) {
        // The audit row keeps the bare message (a stored column); the log
        // line gets the full cause chain.
        const errorMessage = err instanceof Error ? err.message : String(err)
        cfg.logger?.error('tool execution failed', { toolName: cfg.name, err: describeError(err) })
        return refuse('internal', ERROR_MESSAGE, ERROR_MESSAGE, errorMessage, [UNREADABLE_GUIDANCE])
      }

      // The compatibility path: text, copy guard, byte budget — as 0.61.1.
      if (!isToolOutcome(raw)) {
        const legacy = raw as ToolResult
        try {
          // principle 37: every tool's text passes every registered copy guard.
          for (const guard of guards())
            guard(legacy.text, cfg.name)
        }
        catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err)
          cfg.logger?.error('tool execution failed', { toolName: cfg.name, err: describeError(err) })
          return finish({
            result: 'error',
            text: ERROR_MESSAGE,
            outcome: errorOutcome('copy_guard', ERROR_MESSAGE, [UNREADABLE_GUIDANCE]),
            legacy: true,
            errorMessage,
          })
        }
        const capped = applyOutputBudget(legacy, cfg.budget)
        return remember({
          result: 'success',
          text: capped.text,
          outcome: {
            status: capped.rowCount > 0 ? 'ok' : 'empty',
            data: null,
            window: null,
            asOf: null,
            error: null,
            truncated: null,
            guidance: [],
          },
          legacy: true,
          resultBytes: capped.bytes,
          resultRowCount: capped.rowCount,
        })
      }

      // 6. Output check: the envelope's rules, then `data` against its schema.
      const problems = checkEnvelope(raw, { impl: true })
      let checked: ToolOutcome<unknown> = raw
      if (problems.length === 0 && raw.data !== null && raw.data !== undefined && cfg.outputSchema) {
        const out = cfg.outputSchema.safeParse(raw.data)
        if (out.success)
          checked = { ...raw, data: out.data }
        else
          problems.push(...describeIssues(out.error.issues as never))
      }
      if (problems.length > 0) {
        cfg.logger?.error('tool result failed validation', { toolName: cfg.name, problems })
        const text = refuse('output_invalid', ERROR_MESSAGE, ERROR_MESSAGE, problems.join('; '), [UNREADABLE_GUIDANCE])
        if ((cfg.outputValidation ?? (isTestRuntime() ? 'throw' : 'error_outcome')) === 'throw')
          throw new ToolOutputError(cfg.name, problems)
        return text
      }
      // The impl's `truncated` is never trusted.
      checked = { ...checked, data: checked.data ?? null, truncated: null }

      // 7. Copy guard over every string the result carries.
      try {
        for (const guard of guards()) {
          for (const s of stringLeaves(checked))
            guard(s, cfg.name)
        }
      }
      catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        cfg.logger?.error('tool result failed the copy guard', { toolName: cfg.name, err: describeError(err) })
        return refuse('copy_guard', ERROR_MESSAGE, ERROR_MESSAGE, errorMessage, [UNREADABLE_GUIDANCE])
      }

      if (checked.status === 'error') {
        // `outcome.invalid`: the impl refused its arguments (message guarded above).
        const e = checked.error!
        return refuse('invalid_args', e.message, e.message, e.message, checked.guidance, e.fieldErrors as Record<string, string> | undefined)
      }

      // 8–9. Render, fit the budget, guard the text.
      const limit = turn ? Math.min(maxChars, Math.max(MIN_TURN_CHARS, turnChars - turn.chars)) : maxChars
      const renderer = pickRenderer(cfg.name, cfg.render, cfg.renderConfig)
      let fitted: { text: string, outcome: ToolOutcome<unknown> }
      try {
        fitted = fitOutcome(checked, renderer, { toolName: cfg.name, maxChars: limit, now: now() }, cfg.toolBudget)
      }
      catch (err) {
        cfg.logger?.error('tool result could not be rendered', { toolName: cfg.name, err: describeError(err) })
        return refuse('internal', ERROR_MESSAGE, ERROR_MESSAGE, err instanceof Error ? err.message : String(err), [UNREADABLE_GUIDANCE])
      }
      try {
        // Catches words the renderer or the framework added.
        for (const guard of guards())
          guard(fitted.text, cfg.name)
      }
      catch (err) {
        cfg.logger?.error('tool result failed the copy guard', { toolName: cfg.name, err: describeError(err) })
        return refuse('copy_guard', ERROR_MESSAGE, ERROR_MESSAGE, err instanceof Error ? err.message : String(err), [UNREADABLE_GUIDANCE])
      }
      const text = fitted.text.length <= limit ? fitted.text : hardCut(fitted.text, limit)

      const lists = cfg.toolBudget?.listPaths ?? []
      const rowCount = lists.length > 0
        ? lists.reduce((n, p) => n + ((getPath(fitted.outcome.data, p) as unknown[] | undefined)?.length ?? 0), 0)
        : (fitted.outcome.data !== null ? 1 : 0)

      return remember({
        result: 'success',
        text,
        outcome: fitted.outcome,
        legacy: false,
        resultBytes: byteLength(text),
        resultRowCount: rowCount,
        truncatedItems: fitted.outcome.truncated?.droppedItems ?? 0,
      })
    },
  })

  toolMetas.set(t, {
    title: cfg.title,
    inputSchema: parameters,
    outputSchema: cfg.outputSchema,
    annotations: cfg.annotations,
  })
  return t
}

function cacheEntry(end: Ending): CachedCall {
  return {
    text: end.text,
    outcome: end.outcome,
    auditOutcome: end.result,
    legacy: end.legacy,
    resultBytes: end.resultBytes ?? null,
    resultRowCount: end.resultRowCount ?? null,
    truncatedItems: end.truncatedItems ?? null,
  }
}
