// @mongrov/analytics/tools — the AI tool framework.
//
// `createAnalyticsTools` builds an AI SDK tool map from the platform's tool
// (`getInsights`) and every registered pack's `tools`, each wrapped by
// `makeTool`: input check → answer cap → rate limit → authorize → execute →
// output check → copy guard → render → budget → audit (batched into
// `tool_call_audit`) → onResult. Structured tools are declared with
// `defineTool` and return a `ToolOutcome`. The MCP server is the `./mcp`
// subpath.

export * from './audit'
export * from './authorize'
export { toolRead } from './bounded'
export * from './budget'
export { defineTool, lintToolDefinition, MAX_TOOL_DESCRIPTION_CHARS, TOOL_NAME_RE } from './define'
export type { ToolAnnotations, ToolDefinition, ToolExecContext } from './define'
export { fnv1a64 } from './digest'
export * from './factory'
export { DEFAULT_MAX_CHARS, DEFAULT_TURN_CHARS, MIN_TURN_CHARS } from './fit'
export type { ToolBudget } from './fit'
export { deltaPct, formatBytes, popStddev } from './formatters/text'
export {
  getInsights,
  type GetInsightsInput,
  getInsightsInputSchema,
} from './impls/insights'

export { toJsonSchemaObject, toOutputJsonSchema } from './json-schema'
export { localDay, tzParam } from './local-day'
export {
  isToolOutcome,
  MAX_GUIDANCE_CHARS,
  MAX_GUIDANCE_ITEMS,
  MAX_WINDOW_LABEL_CHARS,
  outcome,
  TOOL_ERROR_CODES,
  TOOL_STATUSES,
} from './outcome'
export type {
  OutcomeMeta,
  ToolError,
  ToolErrorCode,
  ToolOutcome,
  ToolStatus,
  ToolTruncation,
  ToolWindow,
} from './outcome'
export { toolOutcomeJsonSchema } from './outcome-schema'
export * from './rate-limit'
export { describeAge, renderers } from './render'
export type { RenderContext, ToolRenderConfig, ToolRenderer } from './render'
export { lintToolInputSchema, parseLikeAppleBridge } from './schema-lint'
export type { BridgeParseResult, LintIssue, LintOptions } from './schema-lint'
export type { ToolTurn, TurnSummary } from './turns'
export * from './types'

export {
  CALL_LIMIT_GUIDANCE,
  DUPLICATE_CALL_GUIDANCE,
  makeTool,
  type MakeToolConfig,
  type StructuredToolImpl,
  type ToolCallResult,
  ToolOutputError,
  UNREADABLE_GUIDANCE,
} from './wrap'
