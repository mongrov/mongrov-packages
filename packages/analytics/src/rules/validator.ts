/**
 * Static validation for rules — sampling-minimum + rawSql exposure check.
 *
 * Called at `register()` time (before compilation). Fails fast with a
 * `RuleValidationError` whose message includes the metric's sampling
 * cadence + the minimum viable window.
 */

import { METRIC_METADATA, type MetricId } from '../core/metric_metadata'
import type { RulesLogger } from './types'
import { type Rule, RuleValidationError, type Window, WINDOWS } from './schema'

/** Window durations in minutes. */
const WINDOW_MINUTES: Record<Window, number> = {
  '1h': 60,
  '6h': 6 * 60,
  '24h': 24 * 60,
  '3d': 3 * 24 * 60,
  '7d': 7 * 24 * 60,
  '30d': 30 * 24 * 60,
}

/**
 * Explicit table per spec §Sampling-minimum validator. The remaining
 * exposed metrics fall through to a derived allow-list built from
 * `METRIC_METADATA[id].sampling_minutes` (see `allowedWindowsFor`).
 */
const EXPLICIT_SAMPLING_MINIMUMS: Partial<Record<MetricId, Window[]>> = {
  hrv_ms: ['24h', '3d', '7d', '30d'],
  stress: ['6h', '24h', '3d', '7d', '30d'],
  hr_bpm: ['1h', '6h', '24h', '3d', '7d', '30d'],
  spo2: ['6h', '24h', '3d', '7d', '30d'],
  temp_c: ['24h', '3d', '7d', '30d'],
  activity_steps: ['1h', '6h', '24h', '3d', '7d', '30d'],
  sleep_total_minutes: ['3d', '7d'],
  device_battery: ['1h', '6h', '24h'],
}

/**
 * Allow-list of windows compatible with `metric.sampling_minutes`.
 * A window is compatible iff its duration ≥ (2 × sampling cadence),
 * i.e. the query is guaranteed to see at least two samples worst-case.
 * `per_session` metrics (sleep_score, sleep_total_minutes) require ≥ 3d.
 */
export function allowedWindowsFor(metric: MetricId): Window[] {
  const explicit = EXPLICIT_SAMPLING_MINIMUMS[metric]
  if (explicit) return explicit
  const cadence = METRIC_METADATA[metric].sampling_minutes
  if (cadence === 'per_session') {
    return ['3d', '7d', '30d']
  }
  const minWindow = cadence * 2
  return WINDOWS.filter(w => WINDOW_MINUTES[w] >= minWindow)
}

/** Columns whose metric is marked `collected_only`. */
const COLLECTED_ONLY_COLUMNS = new Set(
  Object.values(METRIC_METADATA)
    .filter(entry => entry.exposure === 'collected_only')
    .map(entry => entry.column),
)

function samplingLabel(metric: MetricId): string {
  const cadence = METRIC_METADATA[metric].sampling_minutes
  return cadence === 'per_session'
    ? 'once per sleep session'
    : `every ${cadence}min`
}

/**
 * Validate a parsed rule. Throws `RuleValidationError` on any of:
 *   - window smaller than the metric sampling cadence allows,
 *   - rawSql references a `collected_only` column without `exposureOverride: true`.
 * When rawSql is present with `exposureOverride: true`, emits a warn via `logger`.
 */
export function validateRule(rule: Rule, logger?: RulesLogger): void {
  const allowed = allowedWindowsFor(rule.metric)
  if (!allowed.includes(rule.window)) {
    throw new RuleValidationError(
      `Rule ${rule.id}: metric ${rule.metric} sampled ${samplingLabel(rule.metric)}. `
      + `Window ${rule.window} too small. Minimum viable: ${allowed[0]}.`,
    )
  }

  if (rule.rawSql) {
    const references = referencedCollectedOnlyColumns(rule.rawSql)
    if (references.length > 0 && !rule.exposureOverride) {
      throw new RuleValidationError(
        `Rule ${rule.id}: rawSql references collected_only column(s) [${references.join(', ')}]. `
        + `Set exposureOverride: true to acknowledge.`,
      )
    }
    if (rule.exposureOverride && logger) {
      logger.warn('rules.validator: rawSql exposureOverride active', {
        ruleId: rule.id,
        columns: references,
      })
    }
  }
}

/** Scan a rawSql body for whole-word references to collected-only columns. */
export function referencedCollectedOnlyColumns(sql: string): string[] {
  const hits = new Set<string>()
  for (const col of COLLECTED_ONLY_COLUMNS) {
    const pattern = new RegExp(`\\b${col}\\b`)
    if (pattern.test(sql)) hits.add(col)
  }
  return Array.from(hits)
}
