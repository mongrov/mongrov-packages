/**
 * The health pack's AI tools: per-vital summaries, trends and anomalies over
 * the clean views. `createAnalyticsTools` wraps each with the framework's
 * authorization, rate limit, audit and output budget.
 */

import type { PackTool } from '../../../../core/packs'
import type { GetInsightsInput } from '../../../../tools/impls/insights'
import type { makeTool } from '../../../../tools/wrap'
import type { GetActivityTotalInput } from './impls/activity'
import type { DetectAnomalyInput } from './impls/anomaly'
import type { CompareTrendInput } from './impls/compare'
import type { GetHeartRateInput } from './impls/heart-rate'
import type { GetHRVInput } from './impls/hrv'
import type { GetSleepSummaryInput } from './impls/sleep'
import type { GetSpO2Input } from './impls/spo2'
import type { GetStressInput } from './impls/stress'
import type { GetTemperatureInput } from './impls/temperature'
import { getActivityTotal, getActivityTotalInputSchema } from './impls/activity'
import { detectAnomaly, detectAnomalyInputSchema } from './impls/anomaly'
import { compareTrend, compareTrendInputSchema } from './impls/compare'
import { getHeartRate, getHeartRateInputSchema } from './impls/heart-rate'
import { getHRV, getHRVInputSchema } from './impls/hrv'
import { getSleepSummary, getSleepSummaryInputSchema } from './impls/sleep'
import { getSpO2, getSpO2InputSchema } from './impls/spo2'
import { getStress, getStressInputSchema } from './impls/stress'
import { getTemperature, getTemperatureInputSchema } from './impls/temperature'

const DESCRIPTIONS = {
  getHRV: 'Return the requester\'s or a family member\'s average HRV per day '
    + 'over the last N days (1..90). Args: userId, days.',
  getSleepSummary: 'Return nightly sleep duration and efficiency for a user '
    + 'over the last N days (1..30). Args: userId, days.',
  getActivityTotal: 'Return total steps and active minutes per day for a user '
    + 'over the last N days (1..30). Args: userId, days.',
  compareTrend: 'Compare a user\'s metric average across two windows. Args: '
    + 'userId, metric (hrv_ms|sleep_total_minutes|activity_steps), '
    + 'currentWindowDays, priorWindowDays (each 1..30).',
  detectAnomaly: 'Flag statistical outliers (>= stddevThreshold from baseline) '
    + 'in a user\'s metric over the last lookbackDays. Args: userId, metric '
    + '(hrv_ms|sleep_total_minutes|activity_steps), lookbackDays (7..90), '
    + 'stddevThreshold (1..4, default 2).',
  getSpO2: 'Return nightly blood-oxygen averages during sleep for a user, '
    + 'with how many brief low moments occurred each night and how it '
    + 'compares to their usual range. Args: userId, days (1..90).',
  getTemperature: 'Return a user\'s daily temperature in Celsius — average, high and low per day — alongside their own usual range. Says how it compares to their usual, never whether it is high. Args: userId, days (1..90).',
  getHeartRate: 'Return a user\'s daily heart rate in beats per minute — average, low and high per day, on the user\'s own days — alongside their usual daily average. Says how it compares to their usual, never whether it is high. Args: userId, days (1..90).',
  getStress: 'Return a user\'s daily stress score (0-100) — average and high per day, on the user\'s own days, counting the same readings the app shows (off-wrist and warm-up readings left out) — alongside their usual daily average. Compares to their usual; never calls a day tense on its own. Args: userId, days (1..90).',
} as const

/** In the order the model has always been offered them. */
export const healthTools: Readonly<Record<string, PackTool>> = {
  getSpO2: { description: DESCRIPTIONS.getSpO2, inputSchema: getSpO2InputSchema, impl: getSpO2 },
  getTemperature: { description: DESCRIPTIONS.getTemperature, inputSchema: getTemperatureInputSchema, impl: getTemperature },
  getHeartRate: { description: DESCRIPTIONS.getHeartRate, inputSchema: getHeartRateInputSchema, impl: getHeartRate },
  getStress: { description: DESCRIPTIONS.getStress, inputSchema: getStressInputSchema, impl: getStress },
  getHRV: { description: DESCRIPTIONS.getHRV, inputSchema: getHRVInputSchema, impl: getHRV },
  getSleepSummary: { description: DESCRIPTIONS.getSleepSummary, inputSchema: getSleepSummaryInputSchema, impl: getSleepSummary },
  getActivityTotal: { description: DESCRIPTIONS.getActivityTotal, inputSchema: getActivityTotalInputSchema, impl: getActivityTotal },
  compareTrend: { description: DESCRIPTIONS.compareTrend, inputSchema: compareTrendInputSchema, impl: compareTrend },
  detectAnomaly: { description: DESCRIPTIONS.detectAnomaly, inputSchema: detectAnomalyInputSchema, impl: detectAnomaly },
}

/** The tool map with the health and platform tools, typed per tool. */
export interface AnalyticsToolMap {
  getHRV: ReturnType<typeof makeTool<GetHRVInput>>
  getSleepSummary: ReturnType<typeof makeTool<GetSleepSummaryInput>>
  getActivityTotal: ReturnType<typeof makeTool<GetActivityTotalInput>>
  compareTrend: ReturnType<typeof makeTool<CompareTrendInput>>
  detectAnomaly: ReturnType<typeof makeTool<DetectAnomalyInput>>
  getSpO2: ReturnType<typeof makeTool<GetSpO2Input>>
  getTemperature: ReturnType<typeof makeTool<GetTemperatureInput>>
  getHeartRate: ReturnType<typeof makeTool<GetHeartRateInput>>
  getStress: ReturnType<typeof makeTool<GetStressInput>>
  getInsights: ReturnType<typeof makeTool<GetInsightsInput>>
}
