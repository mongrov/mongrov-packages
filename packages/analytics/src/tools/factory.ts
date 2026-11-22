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
 *   - output budget  (bytes for `ToolResult` text, default 4096 / 100 rows;
 *                     characters for structured results, default 1200 per
 *                     result and 3600 per answer)
 *   - answers        (`beginTurn`: the per-answer call cap and cache)
 *   - result events  (`onResult`)
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
import type { ToolTurn } from './turns'

import type {
  AnalyticsToolsConfig,
  AuditWriter,
  OutputBudget,
  ToolContext,
  ToolResultEvent,
} from './types'
import { AnalyticsError, describeError } from '../core/errors'
import { packExtensions } from '../core/packs'
import { createAuditWriter } from './audit'
import { familyScopeAuthorize } from './authorize'
import { DEFAULT_MAX_CHARS, DEFAULT_TURN_CHARS } from './fit'
import { createRateLimiter } from './rate-limit'
import { createTurnTracker } from './turns'
import {
  DEFAULT_OUTPUT_BUDGET,
  DEFAULT_RATE_LIMIT,
} from './types'
import { makeTool } from './wrap'

/** Every registered pack's wrapped tools, by name. */
export type AnalyticsToolMap = Record<string, ReturnType<typeof makeTool<any>>>

/** The default per-answer policy: 4 calls, repeats answered from the cache. */
export const DEFAULT_CALL_LIMIT = Object.freeze({ perTurn: 4, dedupe: true })

export interface AnalyticsToolsHandle {
  /** The pack tools, plus every tool passed to `add`. What MCP lists. */
  tools: AnalyticsToolMap
  /**
   * Wrap a host's own tool in the same chain as the pack tools: argument
   * validation, the answer's call cap, the shared rate limiter,
   * authorization, output validation, every pack's copy guard, rendering,
   * the budget and the same audit writer, under the context set by
   * `setContext`. The tool is returned, not added to `tools` (use `add` for
   * that). Throws `invalid_config` for a name already in `tools`: the two
   * would share rate-limit buckets and be indistinguishable in the audit.
   */
  wrap: (name: string, def: PackTool) => ReturnType<typeof makeTool<any>>
  /**
   * `wrap` a host tool AND list it in `tools`, so MCP sees it too. Takes a
   * `ToolDefinition` (its `name` is the key). Add tools before creating an
   * MCP server: the server lists the tools it finds then.
   */
  add: (def: PackTool & { name: string }) => ReturnType<typeof makeTool<any>>
  /**
   * Open an answer: until `end()`, calls are capped (`callLimit.perTurn`),
   * the first identical repeat is served from the answer's cache (later ones
   * are refused with one short line), and the results share one
   * character budget. Opening one closes any still open. Call `end()` in a
   * `finally`.
   */
  beginTurn: (opts?: { id?: string }) => ToolTurn
  /** Listen to every finished call (after its audit record). Returns the unsubscribe. */
  onResult: (listener: (event: ToolResultEvent) => void) => () => void
  setContext: (ctx: ToolContext | null) => void
  auditWriter: AuditWriter
  close: () => Promise<void>
}

export function createAnalyticsTools(
  config: AnalyticsToolsConfig,
): AnalyticsToolsHandle {
  const { maxChars, turnChars, ...bytes } = config.outputBudget ?? {}
  const budget: OutputBudget = {
    ...DEFAULT_OUTPUT_BUDGET,
    ...bytes,
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

  const turns = createTurnTracker()
  const limit = config.callLimit === false ? null : (config.callLimit ?? DEFAULT_CALL_LIMIT)
  const listeners = new Set<(event: ToolResultEvent) => void>()
  if (config.onResult)
    listeners.add(config.onResult)
  const emit = (event: ToolResultEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event)
      }
      catch (err) {
        // A listener never changes the model's result.
        config.logger?.warn('tool onResult listener threw', { toolName: event.toolName, err: describeError(err) })
      }
    }
  }

  const shared = {
    analytics: config.analytics,
    authorize,
    rateLimiter,
    audit,
    budget,
    logger: config.logger,
    ctxProvider,
    clock: config.clock,
    renderConfig: config.render,
    maxChars: maxChars ?? DEFAULT_MAX_CHARS,
    turnChars: turnChars ?? DEFAULT_TURN_CHARS,
    outputValidation: config.outputValidation,
    turns,
    callLimit: limit
      ? { perTurn: limit.perTurn, dedupe: limit.dedupe ?? true }
      : { perTurn: null, dedupe: false },
    emit,
  }

  const build = (name: string, def: PackTool) => makeTool({
    ...shared,
    name,
    title: def.title,
    description: def.description,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    render: def.render,
    toolBudget: def.budget,
    annotations: def.annotations,
    impl: def.impl as never,
  })

  // Every registered pack's tools, in pack order (the platform's last).
  // Names are unique across packs: `registerPack` rejects a collision.
  const tools = Object.fromEntries(
    packExtensions<Readonly<Record<string, PackTool>>>('tools')
      .flatMap(byName => Object.entries(byName))
      .map(([name, def]) => [name, build(name, def)]),
  ) as unknown as AnalyticsToolMap

  const wrap = (name: string, def: PackTool) => {
    if (Object.prototype.hasOwnProperty.call(tools, name))
      throw new AnalyticsError('invalid_config', `tool "${name}" is already a pack tool`)
    return build(name, def)
  }

  return {
    tools,
    wrap,
    add(def) {
      const t = wrap(def.name, def)
      tools[def.name] = t
      return t
    },
    beginTurn: opts => turns.begin(opts),
    onResult(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
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
