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
export type BaselineDailyAggregate
  = | 'avg'
    | 'sum'
    | 'session'
  /**
   * D-G: minimum reading inside the night's sleep session(s), attributed to
   * the local day the sleep ENDED in. The daily value is a minimum; the
   * baseline's p10/p50/p90 are then the standard quantiles ACROSS those
   * nightly minima.
   *
   * "Usual resting" is p50 of per-night minima — never a minimum across
   * nights, which would be the best night in 30 rather than a typical one.
   */
    | 'nightly_min'
  /**
   * Mean of readings taken while still — no activity within ±15 min. This is
   * the input for the cross-vital factor "a higher resting heart rate" on the
   * Temperature and HRV screens, which asks a DAYTIME question ("was your
   * rate higher than usual while you were still today"), not a nightly one.
   *
   * Distinct from `nightly_min` and deliberately named apart: `resting_hr`
   * and `resting_gated_avg` are two metrics that must never be confused.
   */
    | 'resting_avg'

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
  /**
   * Smallest increment the CURRENT ring actually reports, in the metric's
   * own units (sprint6 §7).
   *
   * Drives the display precision clamp and the Day-view mark rule: a
   * whole-degree temperature reading cannot support a continuous intra-day
   * curve, so the screen shows discrete marks instead of segments. Storage
   * precision is a separate thing — `temperature.temp_c` is DECIMAL(4,1) so
   * a finer device needs no migration, but today's hardware still emits 1.0.
   *
   * NOT per device generation, which is what sprint6 §7 asks for. There is
   * no generation, model or hardware-revision field anywhere in the schema:
   * `device_id` is `hash(brand + hardware_id)` by principle 26 and is opaque
   * by construction, so nothing can key a per-generation lookup today. This
   * field is the current-hardware value; when a generation key exists, this
   * becomes its default row rather than being replaced.
   */
  precision?: number
}

/**
 * Frozen metric registry, verbatim from spec §Metric metadata.
 *
 * v0.1.0 apps consume this for exposure gating; adding metrics is a spec
 * change (bump metadata; add DDL column if new).
 */
export const METRIC_METADATA = Object.freeze({
  hrv_ms: { table: 'hrv', column: 'hrv_ms', sampling_minutes: 60, exposure: 'full', baselineDailyAggregate: 'avg', precision: 1 },
  stress: { table: 'hrv', column: 'stress', sampling_minutes: 60, exposure: 'full', baselineDailyAggregate: 'avg', precision: 1 },
  systolic_bp: { table: 'hrv', column: 'systolic_bp', sampling_minutes: 60, exposure: 'collected_only' },
  diastolic_bp: { table: 'hrv', column: 'diastolic_bp', sampling_minutes: 60, exposure: 'collected_only' },
  vascular_aging: { table: 'hrv', column: 'vascular_aging', sampling_minutes: 60, exposure: 'collected_only' },
  hr_bpm: { table: 'heart_rate', column: 'bpm', sampling_minutes: 10, exposure: 'full', baselineDailyAggregate: 'avg', precision: 1 },
  /**
   * D-G. Two HR-derived metrics, not one, and the names carry the difference:
   *
   *   resting_hr        nightly LOW  — what a doctor, a previous wearable and
   *                     the creative all mean by "resting heart rate"
   *   resting_gated_avg still-time MEAN — the daytime input for the
   *                     cross-vital factor "a higher resting heart rate"
   *
   * `hr_bpm` (all readings) is untouched; Vitality consumes it.
   */
  resting_hr: { table: 'heart_rate', column: 'bpm', sampling_minutes: 10, exposure: 'full', baselineDailyAggregate: 'nightly_min', precision: 1 },
  resting_gated_avg: { table: 'heart_rate', column: 'bpm', sampling_minutes: 10, exposure: 'full', baselineDailyAggregate: 'resting_avg', precision: 1 },
  spo2: { table: 'spo2', column: 'spo2', sampling_minutes: 30, exposure: 'full', baselineDailyAggregate: 'avg', precision: 1 },
  temp_c: { table: 'temperature', column: 'temp_c', sampling_minutes: 30, exposure: 'full', baselineDailyAggregate: 'avg', precision: 1 },
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

/**
 * Reporting precision for a metric, or `undefined` when unstated.
 *
 * Accessor rather than a property read for the same reason as
 * `baselineAggregateFor`: the `as const` registry narrows each entry to its
 * own literal type, and the field is genuinely absent — not `undefined` — on
 * entries without one.
 */
export function precisionFor(id: MetricId): number | undefined {
  const entry = METRIC_METADATA[id] as MetricMetadataEntry
  return entry.precision
}

/**
 * Does this metric's data support a continuous intra-day curve?
 *
 * `false` when the device reports in steps coarse enough that a line between
 * readings would be drawn detail the hardware never measured — the temp
 * screen's mark rule (sprint6 §7): whole-degree ⇒ discrete marks, no
 * segments.
 */
export function supportsContinuousCurve(id: MetricId): boolean {
  const p = precisionFor(id)
  return p !== undefined && p < 1
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
