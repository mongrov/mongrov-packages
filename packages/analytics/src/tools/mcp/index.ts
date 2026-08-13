/**
 * `@mongrov/analytics/tools/mcp` — Model Context Protocol server for
 * the six analytics tools. See `./README.md` for wiring examples.
 *
 * Importing this barrel does NOT itself construct a server. Callers
 * gate SDK-touching code behind `shouldStartMcpServer()`; combined
 * with the package's `sideEffects: false`, prod bundles reachable
 * only through this subpath drop the `@modelcontextprotocol/sdk`
 * runtime entirely.
 */

export { toMcpTools } from './adapter'
export type { McpTool } from './adapter'

export { assertMcpAllowed, McpDisabledError, shouldStartMcpServer } from './guard'

export { createMcpServer } from './server'
export type {
  CreateMcpServerConfig,
  McpServerHandle,
} from './server'

export { createHttpTransport } from './transports/http'
export type {
  CreateHttpTransportConfig,
  HttpTransportHandle,
} from './transports/http'

export { createStdioTransport } from './transports/stdio'
export type { CreateStdioTransportOptions } from './transports/stdio'
