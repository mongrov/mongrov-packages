/**
 * `toMcpTools` — adapt the six wrapped AI SDK v4 tools that back
 * `AnalyticsToolsHandle` into the shape MCP servers speak.
 *
 * MCP servers want `{ name, description, inputSchema (JSON Schema),
 * handler(args) => { content: [{ type: 'text', text }] } }`. Our
 * factory returns AI SDK v4 tools whose `execute(args, opts) =>
 * Promise<string>` already runs the full
 * rate → auth → execute → budget → audit chain — so the adapter is
 * a thin translation layer, not a second wrapper.
 *
 * The Zod parameter schemas are converted to JSON Schema draft-7 via
 * `zod-to-json-schema` (drops `$schema` and `additionalProperties`
 * so MCP clients get a compact tool descriptor). `.default()` values
 * survive the conversion (asserted in the tests) so LLMs see the
 * documented defaults on `detectAnomaly.stddevThreshold` and
 * `getInsights.days`.
 */

import { zodToJsonSchema } from 'zod-to-json-schema'
import type { AnalyticsToolsHandle } from '../factory'

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: unknown) => Promise<{
    content: { type: 'text', text: string }[]
    isError?: boolean
  }>
}

export function toMcpTools(handle: AnalyticsToolsHandle): McpTool[] {
  const entries = Object.entries(handle.tools) as [
    keyof AnalyticsToolsHandle['tools'],
    AnalyticsToolsHandle['tools'][keyof AnalyticsToolsHandle['tools']],
  ][]

  return entries.map(([name, tool]) => {
    const parameters = tool.parameters as Parameters<typeof zodToJsonSchema>[0]
    const rawSchema = zodToJsonSchema(parameters, {
      target: 'jsonSchema7',
      $refStrategy: 'none',
    }) as Record<string, unknown>

    // Strip the top-level $schema marker — MCP clients don't need it,
    // and its presence bloats every list_tools response.
    const { $schema: _drop, ...inputSchema } = rawSchema

    return {
      name: String(name),
      description: tool.description ?? '',
      inputSchema,
      handler: async (args: unknown) => {
        if (!tool.execute) {
          return {
            content: [{
              type: 'text' as const,
              text: `Tool ${String(name)} is not executable.`,
            }],
            isError: true,
          }
        }
        const text = await tool.execute(args as never, {
          toolCallId: `mcp:${String(name)}`,
          messages: [],
        })
        return {
          content: [{ type: 'text' as const, text: String(text) }],
        }
      },
    }
  })
}
