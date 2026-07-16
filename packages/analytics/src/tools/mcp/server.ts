/**
 * `createMcpServer` — wrap an `AnalyticsToolsHandle` in an MCP server
 * that speaks `tools/list` + `tools/call` to any MCP client.
 *
 * We use the low-level `Server` + `setRequestHandler` rather than the
 * higher-level `McpServer.registerTool`, because `registerTool` wants
 * either a Zod raw shape or an `AnySchema`, and our tools were built
 * around `zod.object(...)` (not raw shapes) and are already converted
 * to JSON Schema by `toMcpTools`. Emitting the pre-baked JSON Schema
 * from `tools/list` keeps the source of truth in one place (the Zod
 * schemas in `src/tools/impls/*.ts`).
 *
 * `call_tool` re-dispatches into the wrapped `tool.execute`, which
 * runs the full rate → auth → execute → budget → audit chain via the
 * ctx container the handle owns. `handle.setContext(...)` before an
 * MCP session behaves identically to setting it before an AI SDK turn.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { AnalyticsToolsHandle } from '../factory'
import type { ToolsLogger } from '../types'
import { type McpTool, toMcpTools } from './adapter'

export interface CreateMcpServerConfig {
  toolsHandle: AnalyticsToolsHandle
  /** Server name advertised on `initialize`. Default `'mongrov-analytics'`. */
  name?: string
  /** Server version advertised on `initialize`. Default `'0.1.0'`. */
  version?: string
  logger?: ToolsLogger
}

export interface McpServerHandle {
  /** The underlying SDK server — exposed for advanced callers. */
  server: Server
  /** Attach to a transport and start listening. */
  connect: (transport: Transport) => Promise<void>
  /** Close the connection. Does NOT close the underlying tools handle. */
  close: () => Promise<void>
}

export function createMcpServer(
  config: CreateMcpServerConfig,
): McpServerHandle {
  const mcpTools: McpTool[] = toMcpTools(config.toolsHandle)
  const byName = new Map(mcpTools.map(t => [t.name, t] as const))

  const server = new Server(
    {
      name: config.name ?? 'mongrov-analytics',
      version: config.version ?? '0.1.0',
    },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mcpTools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as {
        type: 'object'
        properties?: Record<string, unknown>
        required?: string[]
      },
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name)
    if (!tool) {
      return {
        content: [{
          type: 'text' as const,
          text: `Unknown tool: ${req.params.name}`,
        }],
        isError: true,
      }
    }
    try {
      return await tool.handler(req.params.arguments ?? {})
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      config.logger?.error('mcp tool handler threw', {
        toolName: req.params.name,
        err: message,
      })
      return {
        content: [{
          type: 'text' as const,
          text: `Tool call failed.`,
        }],
        isError: true,
      }
    }
  })

  return {
    server,
    connect: transport => server.connect(transport),
    close: () => server.close(),
  }
}
