/**
 * `toMcpTools` — adapt the wrapped AI SDK tools of an
 * `AnalyticsToolsHandle` (`handle.tools`: every pack's tools and every tool
 * passed to `handle.add`) into the shape MCP servers speak.
 *
 * The adapter is a thin translation layer, not a second wrapper: each
 * handler runs the tool's own `execute`, so MCP calls get the same chain
 * (validation, rate limit, authorization, output checks, copy guard,
 * budget, audit, `onResult` with `source: 'mcp'`). MCP calls never join an
 * app's answer, so they are not capped or cached per answer.
 *
 * | MCP                      | value                                                         |
 * | `name`/`title`/`description` | from the definition                                        |
 * | `inputSchema`            | the input-view JSON Schema `makeTool` built, minus `$schema`   |
 * | `outputSchema`           | the envelope's JSON Schema, `data` typed from the tool's `outputSchema` (structured tools only) |
 * | `annotations`            | `{ readOnlyHint: true, idempotentHint: true, openWorldHint: false }` merged with the definition's |
 * | `structuredContent`      | the `ToolOutcome` the call ended with (structured tools only)  |
 * | `content`                | one text item: the envelope as JSON (`text: 'json'`, default), or the model's rendered string (`text: 'render'`). A compatibility tool sends its text. |
 * | `isError`                | `status === 'error'` (every code, `invalid_args` included, per MCP 2025-11-25); a compatibility tool: any outcome but success |
 */

import type { ToolAnnotations } from '../define'
import type { AnalyticsToolsHandle } from '../factory'
import { toolOutcomeJsonSchema } from '../outcome-schema'
import { markMcpCall, toolCallRecord, toolMeta } from '../wrap'

export const DEFAULT_MCP_ANNOTATIONS: Readonly<ToolAnnotations> = Object.freeze({
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
})

export interface McpTool {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  /** Structured tools only. */
  outputSchema?: Record<string, unknown>
  annotations: ToolAnnotations
  handler: (args: unknown) => Promise<{
    content: { type: 'text', text: string }[]
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }>
}

export interface ToMcpToolsOptions {
  /**
   * The text copy of a structured result: `'json'` (default) is the
   * serialized envelope, which MCP says a structured result SHOULD carry;
   * `'render'` is the exact string the model would read, for comparing a
   * desktop model against the on-device one.
   */
  text?: 'json' | 'render'
}

export function toMcpTools(handle: AnalyticsToolsHandle, opts: ToMcpToolsOptions = {}): McpTool[] {
  return Object.entries(handle.tools).map(([name, tool]) => {
    const meta = toolMeta(tool)
    // `makeTool` hands the AI SDK a finished JSON Schema (`jsonSchema()`),
    // so `tool.parameters` carries `.jsonSchema`; read it straight through.
    const rawSchema = {
      ...(meta?.inputSchema
        ?? (tool.parameters as unknown as { jsonSchema?: Record<string, unknown> }).jsonSchema
        ?? {}),
    }
    // MCP clients do not need the `$schema` marker, and it bloats every list.
    const { $schema: _drop, ...inputSchema } = rawSchema
    const structured = meta?.outputSchema !== undefined
    const outputSchema = structured ? toolOutcomeJsonSchema(meta!.outputSchema!) : undefined

    return {
      name,
      ...(meta?.title ? { title: meta.title } : {}),
      description: tool.description ?? '',
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
      annotations: { ...DEFAULT_MCP_ANNOTATIONS, ...(meta?.annotations ?? {}) },
      handler: async (args: unknown) => {
        if (!tool.execute) {
          return {
            content: [{ type: 'text' as const, text: `Tool ${name} is not executable.` }],
            isError: true,
          }
        }
        const options = { toolCallId: `mcp:${name}`, messages: [] }
        markMcpCall(options)
        const text = String(await tool.execute(args as never, options))
        const record = toolCallRecord(options)
        if (!structured || !record || record.legacy) {
          return {
            content: [{ type: 'text' as const, text }],
            ...(record !== undefined && record.result !== 'success' ? { isError: true } : {}),
          }
        }
        const outcome = record.outcome as unknown as Record<string, unknown>
        return {
          content: [{ type: 'text' as const, text: opts.text === 'render' ? text : JSON.stringify(outcome) }],
          structuredContent: outcome,
          ...(record.outcome.status === 'error' ? { isError: true } : {}),
        }
      },
    }
  })
}
