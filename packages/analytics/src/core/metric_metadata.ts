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

export interface MetricMetadataEntry {
  table: TableName
  column: string
  sampling_minutes: MetricSamplingMinutes
  exposure: MetricExposure
}

/**
 * Frozen metric registry, verbatim from spec §Metric metadata.
 *
 * v0.1.0 apps consume this for exposure gating; adding metrics is a spec
 * change (bump metadata; add DDL column if new).
 */
export const METRIC_METADATA = Object.freeze({
  hrv_ms: { table: 'hrv', column: 'hrv_ms', sampling_minutes: 60, exposure: 'full' },
  stress: { table: 'hrv', column: 'stress', sampling_minutes: 60, exposure: 'full' },
  systolic_bp: { table: 'hrv', column: 'systolic_bp', sampling_minutes: 60, exposure: 'collected_only' },
  diastolic_bp: { table: 'hrv', column: 'diastolic_bp', sampling_minutes: 60, exposure: 'collected_only' },
  vascular_aging: { table: 'hrv', column: 'vascular_aging', sampling_minutes: 60, exposure: 'collected_only' },
  hr_bpm: { table: 'heart_rate', column: 'bpm', sampling_minutes: 10, exposure: 'full' },
  spo2: { table: 'spo2', column: 'spo2', sampling_minutes: 30, exposure: 'full' },
  temp_c: { table: 'temperature', column: 'temp_c', sampling_minutes: 30, exposure: 'full' },
  activity_steps: { table: 'activity', column: 'steps', sampling_minutes: 1, exposure: 'full' },
  calories: { table: 'activity_bucket', column: 'calories', sampling_minutes: 10, exposure: 'full' },
  distance_km: { table: 'activity_bucket', column: 'distance_km', sampling_minutes: 10, exposure: 'full' },
  sleep_total_minutes: { table: 'sleep_session', column: 'total_minutes', sampling_minutes: 'per_session', exposure: 'full' },
  sleep_score: { table: 'sleep_session', column: 'avg_confidence', sampling_minutes: 'per_session', exposure: 'full' },
  device_battery: { table: 'device_event', column: 'payload', sampling_minutes: 240, exposure: 'full' },
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
