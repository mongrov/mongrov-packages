// @mongrov/analytics/tools — typed AI SDK tools + MCP.
//
// v0.1.0-alpha (T-01..T-12 landed): tool impls, formatters, rate
// limiter, authorize hooks (with optional familyMembersProvider),
// batched `tool_call_audit` writer, output-budget helper, `makeTool`
// wrapper composing rate → auth → execute → budget → audit, and the
// `createAnalyticsTools` factory returning an AI SDK tool map.
// MCP subpath (T-13/T-14) still pending.

export * from './audit'
export * from './authorize'
// Copy guardrails (Sprint 5 T-29, principle 37). Exported so app-side
// formatters and registry `transform` functions can apply the same
// contract to text they generate.
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

export * from './wrap'
