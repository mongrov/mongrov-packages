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
export * from './budget'
export * from './factory'
export * from './rate-limit'
export * from './types'
export * from './wrap'

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
