// @mongrov/analytics/tools — the AI tool framework.
//
// `createAnalyticsTools` builds an AI SDK tool map from the platform's tool
// (`getInsights`) and every registered pack's `tools`, each wrapped by
// `makeTool`: rate limit → authorize → execute → output budget → audit
// (batched into `tool_call_audit`). The MCP server is the `./mcp` subpath.

export * from './audit'
export * from './authorize'
export { toolRead } from './bounded'
export * from './budget'
export * from './factory'
export { deltaPct, formatBytes, popStddev } from './formatters/text'
export {
  getInsights,
  type GetInsightsInput,
  getInsightsInputSchema,
} from './impls/insights'

export { localDay, tzParam } from './local-day'
export * from './rate-limit'
export * from './types'

export { makeTool, type MakeToolConfig } from './wrap'
