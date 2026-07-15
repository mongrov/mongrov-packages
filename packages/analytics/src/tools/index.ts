// @mongrov/analytics/tools — typed AI SDK tools + MCP.
//
// v0.1.0-alpha (T-01..T-08 landed): tool impls, formatters, rate
// limiter, authorize hooks. AI SDK `tool()` handles + `makeTool`
// wrapper + `createAnalyticsTools` factory + `tool_call_audit`
// writer + MCP subpath still pending (T-09..T-14).

export * from './authorize'
export * from './rate-limit'
export * from './types'

export {
  getHRV,
  getHRVInputSchema,
  type GetHRVInput,
} from './impls/hrv'
export {
  getSleepSummary,
  getSleepSummaryInputSchema,
  type GetSleepSummaryInput,
} from './impls/sleep'
export {
  getActivityTotal,
  getActivityTotalInputSchema,
  type GetActivityTotalInput,
} from './impls/activity'
export {
  compareTrend,
  compareTrendInputSchema,
  type CompareTrendInput,
} from './impls/compare'
export {
  detectAnomaly,
  detectAnomalyInputSchema,
  type DetectAnomalyInput,
} from './impls/anomaly'
export {
  getInsights,
  getInsightsInputSchema,
  type GetInsightsInput,
} from './impls/insights'
