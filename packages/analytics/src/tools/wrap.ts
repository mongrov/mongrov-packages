/**
 * `makeTool` — compose an AI SDK `tool()` from a raw impl plus the
 * validate → rate → auth → execute → copy guard → budget → audit chain.
 *
 * The chain order is load-bearing:
 *   0. Validate    → parse the arguments with the tool's Zod schema, so
 *                    defaults apply and bounds hold whatever the caller
 *                    checked (no runtime on any path validates them first).
 *   1. Rate limit  → cheap, no I/O; short-circuits abusive callers.
 *   2. Authorize   → may hit SQL/provider; runs after rate cap.
 *   3. Execute     → real tool work.
 *   4. Copy guard  → every registered pack's `copyGuard` over the text.
 *   5. Budget      → trim oversized text before returning.
 *   6. Audit       → record every terminal state (success / reject
 *                    / rate-limited / error).
 *
 * Every branch records exactly one audit entry. The wrapper never
 * throws — errors resolve to a short LLM-friendly string. Because
 * the AI SDK `execute(input)` signature has no per-call context arg,
 * the caller supplies a `ctxProvider()` closure that returns the
 * current `ToolContext` at invocation time (the factory backs this
 * with a mutable container updated per request).
 */

import type { ZodTypeAny } from 'zod'
import type { AnalyticsEngine } from '../core/types'
import type { RateLimiter } from './rate-limit'
import type {
  AuditEntry,
  AuditWriter,
  AuthorizeFn,
  OutputBudget,
  ToolContext,
  ToolImpl,
  ToolsLogger,
} from './types'
import { jsonSchema, tool } from 'ai'
import { describeError } from '../core/errors'
import { packExtensions } from '../core/packs'
import { applyOutputBudget } from './budget'
import { describeInvalidArgs } from './validate'

const RATE_LIMIT_MESSAGE = 'Rate limit exceeded. Try again shortly.'
const AUTHZ_MESSAGE = 'Not authorized to access that user\'s data.'
const ERROR_MESSAGE = 'Tool call failed.'
const NO_CONTEXT_MESSAGE = 'Tool call failed: request context not set.'

/** How one call ended — what `tool_call_audit.outcome` records, plus a refusal of its arguments. */
export type ToolCallResult = 'success' | 'invalid_args' | 'rate_limited' | 'authorized_reject' | 'error'

/**
 * @internal The result of a call, keyed by the options object handed to
 * `execute`. The AI SDK sees only the text; the MCP adapter passes its own
 * options object and reads this back to set `isError`, without the text
 * changing shape.
 */
const callResults = new WeakMap<object, ToolCallResult>()

/** @internal How the call made with `options` ended; `undefined` if it never ran. */
export function toolCallResult(options: object): ToolCallResult | undefined {
  return callResults.get(options)
}

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

/**
 * Convert a Zod schema to plain JSON Schema for the AI SDK.
 *
 * The SDK's `tool({ parameters: zodSchema })` path converts using zod-3
 * internals. Handed a zod-4 schema it emits `type: "None"`, and OpenAI
 * rejects the whole request:
 *
 *   AI_APICallError: Invalid schema for function 'getReading': schema must be a
 *   JSON Schema of 'type: "object"', got 'type: "None"'.
 *
 * Because tools are sent on every request, one bad schema breaks all chat —
 * even a plain "hi" that needs no tool at all.
 *
 * This package supports zod 3 and 4 (`^3.23.8 || ^4.0.0`), so the consumer's
 * version is not ours to pick. Converting here and passing `jsonSchema()`
 * removes the coupling entirely: the SDK gets a finished JSON Schema and
 * never inspects a Zod object.
 *
 * The schema describes the INPUT side (`io: 'input'`): a field with a
 * `.default()` is optional to the caller, because `makeTool` applies the
 * default. zod 4's default (output) view lists it in `required`, which made
 * every strict caller, Apple's on-device model among them, supply it.
 */
export function toJsonSchemaObject(schema: ZodTypeAny): Record<string, unknown> {
  // zod 4 ships its own converter; zod 3 needs the companion package.
  const z4 = (schema as unknown as { _zod?: unknown })._zod
  if (z4 !== undefined) {
    // `require('zod')` only, as before: a bundler resolves every literal
    // require, and a consumer on zod 3 has no zod 4 subpath to resolve.
    const zod = require('zod') as {
      toJSONSchema: (s: unknown, params?: { io?: 'input' | 'output' }) => Record<string, unknown>
    }
    const input = zod.toJSONSchema(schema, { io: 'input' })
    // The input view leaves out `additionalProperties: false`; keep the
    // object closed, as the output view (and every earlier release) had it.
    const closed = zod.toJSONSchema(schema).additionalProperties === false
    return closed ? { ...input, additionalProperties: false } : input
  }

  // zod-to-json-schema already treats a `.default()` field as optional.
  const { zodToJsonSchema } = require('zod-to-json-schema') as {
    zodToJsonSchema: (s: unknown) => Record<string, unknown>
  }
  return zodToJsonSchema(schema)
}

export function makeTool<Input>(cfg: MakeToolConfig<Input>) {
  const clock = cfg.clock ?? Date.now
  const parameters = toJsonSchemaObject(cfg.inputSchema)

  return tool({
    description: cfg.description,
    parameters: jsonSchema(parameters as never),
    execute: async (rawInput: unknown, options?: unknown): Promise<string> => {
      const startMs = clock()
      const ctx = cfg.ctxProvider()
      let args = (rawInput ?? {}) as Record<string, unknown>

      const finish = (
        result: ToolCallResult,
        text: string,
        entry: Partial<Pick<AuditEntry, 'resultBytes' | 'resultRowCount' | 'errorMessage'>> = {},
      ): string => {
        cfg.audit.record({
          ts: new Date(clock()),
          brand: ctx?.brand ?? '',
          familyId: ctx?.familyId ?? '',
          requesterUserId: ctx?.requesterUserId ?? '',
          toolName: cfg.name,
          args,
          resultBytes: entry.resultBytes ?? null,
          resultRowCount: entry.resultRowCount ?? null,
          latencyMs: clock() - startMs,
          // A refused argument list is an error to the audit: the outcome
          // column keeps its four values, and the message says which.
          outcome: result === 'invalid_args' ? 'error' : result,
          errorMessage: entry.errorMessage ?? null,
        })
        if (options !== null && typeof options === 'object')
          callResults.set(options, result)
        return text
      }

      // 0. Ctx guard — audit as error, no rate/auth/execute performed.
      if (!ctx) {
        cfg.logger?.warn('tool invoked without context', { toolName: cfg.name })
        return finish('error', NO_CONTEXT_MESSAGE, { errorMessage: 'context not set' })
      }

      // 1. Validate. No runtime validates before us: the AI SDK's
      // `jsonSchema()` has no validator, Apple's bridge parses without one
      // (and keeps only one numeric bound), and MCP passes arguments
      // straight through. Parsing applies `.default()`s and enforces every
      // bound, so `days: 0` is refused rather than read as "no data".
      const parsed = cfg.inputSchema.safeParse(rawInput ?? {})
      if (!parsed.success) {
        const message = describeInvalidArgs(parsed.error, parameters, rawInput ?? {})
        cfg.logger?.warn('tool arguments rejected', { toolName: cfg.name, message })
        return finish('invalid_args', message, { errorMessage: `invalid_args: ${message}` })
      }
      args = parsed.data as Record<string, unknown>
      const input = parsed.data as Input

      // 2. Rate limit.
      if (cfg.rateLimiter && !cfg.rateLimiter.check(cfg.name, ctx.requesterUserId)) {
        cfg.logger?.warn('tool rate limited', { toolName: cfg.name })
        return finish('rate_limited', RATE_LIMIT_MESSAGE)
      }

      // 3. Authorize.
      if (cfg.authorize) {
        const ok = await cfg.authorize(cfg.name, args, ctx)
        if (!ok) {
          cfg.logger?.warn('tool authorization rejected', { toolName: cfg.name })
          return finish('authorized_reject', AUTHZ_MESSAGE)
        }
      }

      // 4. Execute + copy guard + budget + audit success/error.
      try {
        const raw = await cfg.impl(input, {
          ...ctx,
          analytics: cfg.analytics,
          logger: cfg.logger,
        })
        // principle 37: every tool's text, a pack's or one wrapped by the
        // host, passes every registered copy guard. A guard throws, and the
        // call fails like any other error.
        for (const guard of packExtensions<(text: string, source: string) => void>('copyGuard'))
          guard(raw.text, cfg.name)
        const capped = applyOutputBudget(raw, cfg.budget)
        return finish('success', capped.text, {
          resultBytes: capped.bytes,
          resultRowCount: capped.rowCount,
        })
      }
      catch (err) {
        // The audit row keeps the bare message (a stored column); the log
        // line gets the full cause chain.
        const errorMessage = err instanceof Error ? err.message : String(err)
        // `error`: the impl threw, and the model got a generic apology.
        cfg.logger?.error('tool execution failed', {
          toolName: cfg.name,
          err: describeError(err),
        })
        return finish('error', ERROR_MESSAGE, { errorMessage })
      }
    },
  })
}
