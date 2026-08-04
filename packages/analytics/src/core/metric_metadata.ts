/**
 * Metric registry (spec §Metric metadata).
 *
 * `METRIC_METADATA` maps every consumer-facing metric id to the warehouse
 * column that stores it, the sampling cadence, and the exposure tier
 * (`full` vs `collected_only`). Rules engine + UI decide which metrics to
 * surface based on `exposure`; retention logic (T-14) uses the same table
 * mapping to sweep by column.
 */

import type { TableName } from './schemas'

export type MetricExposure = 'full' | 'collected_only'

/**
 * Sampling cadence in minutes, or the sentinel `'per_session'` for metrics
 * emitted once per sleep session. Keeps the discriminant explicit rather
 * than shoehorning it into a number.
 */
export type MetricSamplingMinutes = number | 'per_session'

/**
 * How a metric collapses to ONE value per local day before quantiles are
 * taken across days (principle 27, "baselines are day-first").
 *
 * - `'avg'`     — mean of the day's readings (spo2, hrv_ms, stress, hr_bpm, temp_c)
 * - `'sum'`     — total across the day (activity_steps)
 * - `'session'` — already one value per night; no daily GROUP BY (sleep)
 *
 * Getting this wrong silently corrupts the "usual range": quantiling raw
 * readings lets a single intra-day dip set p10 for the whole window, which
 * is exactly the bug day-first compute exists to prevent.
 */
export type BaselineDailyAggregate = 'avg' | 'sum' | 'session'

export interface MetricMetadataEntry {
  table: TableName
  column: string
  /**
   * Nominal cadence. **Fallback only** — `device_config.interval_minutes`
   * supersedes this when a row exists for the device (principle 22,
   * hardware-agnostic cadence).
   */
  sampling_minutes: MetricSamplingMinutes
  exposure: MetricExposure
  /**
   * Daily collapse used by baseline compute. Absent for metrics that carry
   * no baseline (BP + vascular aging are `collected_only`; calories,
   * distance and sleep_score have no baseline consumer in v0.2.0).
   */
  baselineDailyAggregate?: BaselineDailyAggregate
}

/**
 * Frozen metric registry, verbatim from spec §Metric metadata.
 *
 * v0.1.0 apps consume this for exposure gating; adding metrics is a spec
 * change (bump metadata; add DDL column if new).
 */
export const METRIC_METADATA = Object.freeze({
  hrv_ms: { table: 'hrv', column: 'hrv_ms', sampling_minutes: 60, exposure: 'full', baselineDailyAggregate: 'avg' },
  stress: { table: 'hrv', column: 'stress', sampling_minutes: 60, exposure: 'full', baselineDailyAggregate: 'avg' },
  systolic_bp: { table: 'hrv', column: 'systolic_bp', sampling_minutes: 60, exposure: 'collected_only' },
  diastolic_bp: { table: 'hrv', column: 'diastolic_bp', sampling_minutes: 60, exposure: 'collected_only' },
  vascular_aging: { table: 'hrv', column: 'vascular_aging', sampling_minutes: 60, exposure: 'collected_only' },
  hr_bpm: { table: 'heart_rate', column: 'bpm', sampling_minutes: 10, exposure: 'full', baselineDailyAggregate: 'avg' },
  spo2: { table: 'spo2', column: 'spo2', sampling_minutes: 30, exposure: 'full', baselineDailyAggregate: 'avg' },
  temp_c: { table: 'temperature', column: 'temp_c', sampling_minutes: 30, exposure: 'full', baselineDailyAggregate: 'avg' },
  activity_steps: { table: 'activity', column: 'steps', sampling_minutes: 1, exposure: 'full', baselineDailyAggregate: 'sum' },
  calories: { table: 'activity_bucket', column: 'calories', sampling_minutes: 10, exposure: 'full' },
  distance_km: { table: 'activity_bucket', column: 'distance_km', sampling_minutes: 10, exposure: 'full' },
  sleep_total_minutes: { table: 'sleep_session', column: 'total_minutes', sampling_minutes: 'per_session', exposure: 'full', baselineDailyAggregate: 'session' },
  sleep_score: { table: 'sleep_session', column: 'avg_confidence', sampling_minutes: 'per_session', exposure: 'full' },
  device_battery: { table: 'device_battery', column: 'battery_pct', sampling_minutes: 240, exposure: 'full' },
} as const satisfies Readonly<Record<string, MetricMetadataEntry>>)

export type MetricId = keyof typeof METRIC_METADATA

/**
 * Whether an app should surface this metric to end users. Metrics marked
 * `collected_only` (BP, vascular aging) are captured for later research but
 * kept out of consumer UI in v0.1.0.
 */
export function isMetricExposed(id: MetricId): boolean {
  return METRIC_METADATA[id].exposure === 'full'
}

/**
 * List of every metric id where `exposure === 'full'` — convenience for
 * UI code that iterates the visible surface.
 */
export function getExposedMetricIds(): MetricId[] {
  return (Object.keys(METRIC_METADATA) as MetricId[]).filter(isMetricExposed)
}

/**
 * Metric ids that carry a `user_baseline` row — those declaring a
 * `baselineDailyAggregate`. Seven in v0.2.0, which at three windows each
 * (7d / 30d / 90d) is the 21-baselines-per-user figure in the Sprint 5
 * design.
 */
export function getBaselineMetricIds(): MetricId[] {
  return (Object.keys(METRIC_METADATA) as MetricId[]).filter(
    id => baselineAggregateFor(id) !== undefined,
  )
}

/**
 * `baselineDailyAggregate` for a metric, or `undefined` when it carries no
 * baseline. Accessor rather than a direct property read because the
 * `as const` registry narrows each entry to its own literal type, and the
 * field is genuinely absent — not `undefined` — on entries without one.
 */
export function baselineAggregateFor(
  id: MetricId,
): BaselineDailyAggregate | undefined {
  const entry = METRIC_METADATA[id] as MetricMetadataEntry
  return entry.baselineDailyAggregate
}

/** Baseline windows computed per metric (Sprint 5 §7). */
export const BASELINE_WINDOW_DAYS = [7, 30, 90] as const
export type BaselineWindowDays = (typeof BASELINE_WINDOW_DAYS)[number]

/**
 * Minimum distinct local DAYS before a baseline row is written
 * (principle 27). Counting readings instead of days is the classic
 * mis-implementation: 15 days of 30-minute SpO₂ sampling is 720 readings
 * but still only 15 days, and must NOT populate a baseline.
 */
export const BASELINE_MIN_DAYS = 20
