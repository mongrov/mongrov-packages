/**
 * Static validation for rules — sampling-minimum + rawSql exposure check.
 *
 * Called at `register()` time (before compilation). Fails fast with a
 * `RuleValidationError` whose message includes the metric's sampling
 * cadence + the minimum viable window.
 */

import type { MetricId } from '../core/metric_metadata'

import type { Rule, Window } from './schema'
import type { RulesLogger } from './types'
import {
  isRegisteredKvKey,
  isRuleReadableKvKey,
  ruleReadableKvKeys,
} from '@mongrov/types/kv-keys'
import { METRIC_METADATA } from '../core/metric_metadata'
import { minimumWindowMinutes } from '../core/sampling'
import { RuleValidationError, WINDOWS } from './schema'

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
  if (explicit)
    return explicit
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
  validateConsecutive(rule)
  validateCadence(rule)
  validateContext(rule)
  validateUserSettingKey(rule)

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

/**
 * T-21 — `consecutive x effective_sampling_minutes` must fit the window.
 *
 * A rule asking for 3 consecutive HRV samples (60-min cadence) inside a 1h
 * window is unsatisfiable: the window holds at most one sample, so the
 * rule can never fire and the author gets silence instead of an error.
 *
 * `effective` sampling comes from `device_config.interval_minutes` at eval
 * time when a row exists (principle 22); at register time only the
 * `metric_metadata` fallback is known, so this check uses the fallback and
 * is deliberately permissive — a denser real device only makes a rule MORE
 * satisfiable, never less.
 */
/**
 * D3 — HRV rules are relative-only (sprint6 §4).
 *
 * There is no meaningful absolute HRV threshold: 30 ms is alarming for one
 * person and unremarkable for another, so a fixed flag is a number that means
 * something different for every user who sees it.
 *
 * This is a validator rather than a review note because review has already
 * failed at it. Every generation of the HRV screen so far has shipped an
 * absolute flag — the most recent as `thresh: 35` on a drag control — and
 * each was caught by a person, late, after the work was done. Code catches
 * it whoever writes it and whenever they write it.
 *
 * `user_setting` is absolute too: letting the user pick 35 ms does not make
 * 35 ms mean anything. Relative targets (`baseline_percent`,
 * `baseline_stddev`, `baseline_offset`) are the whole permitted set.
 */
const RELATIVE_ONLY_METRICS = new Set(['hrv_ms'])
const ABSOLUTE_TARGET_TYPES = new Set(['absolute', 'range', 'user_setting'])

/**
 * Admission policy, checked at REGISTRATION rather than inside
 * `validateRule`.
 *
 * `validateRule` answers "is this rule well-formed?" — a structural question
 * with the same answer everywhere. This answers "may this rule enter the
 * system?", which is a product decision. Keeping them apart matters
 * practically as well as conceptually: unit tests use `hrv_ms` as an ordinary
 * metric to exercise the compiler's absolute branch and the window minimums,
 * and a policy living in the structural validator made 36 of them fail for
 * reasons that had nothing to do with what they assert.
 */
export function assertRegistrable(rule: Rule): void {
  validateRelativeOnly(rule)
}

function validateRelativeOnly(rule: Rule): void {
  if (!RELATIVE_ONLY_METRICS.has(rule.metric))
    return
  if (!ABSOLUTE_TARGET_TYPES.has(rule.target.type))
    return

  throw new RuleValidationError(
    `Rule ${rule.id}: metric ${rule.metric} is relative-only (decision D3) — `
    + `target.type '${rule.target.type}' sets an absolute threshold. There is `
    + `no HRV number that means the same thing for two people; compare against `
    + `the user's own baseline instead (baseline_offset, baseline_percent or `
    + `baseline_stddev). See .specifica/hrv/spec.md D3.`,
  )
}

function validateCadence(rule: Rule): void {
  if (rule.cadence !== 'day')
    return

  // A day-cadence rule counting one day is an aggregate over a single day,
  // which the reading path already expresses more cheaply. Authors who write
  // it almost always meant "days running", so this is a prompt rather than a
  // prohibition — `allowSingleDay` opts out.
  const n = rule.consecutive ?? 1
  if (n < 2 && rule.allowSingleDay !== true) {
    throw new RuleValidationError(
      `Rule ${rule.id}: cadence 'day' needs consecutive >= 2 (got ${n}). `
      + `A single day is an aggregate, not a run — use cadence 'reading', `
      + `or set allowSingleDay: true if one day is genuinely intended.`,
    )
  }
}

function validateConsecutive(rule: Rule): void {
  const n = rule.consecutive
  if (n === undefined || n <= 1)
    return

  // Baseline targets resolve per-window, not per-sample; the compiler has
  // no correct query shape for the combination.
  //
  // `baseline_offset` under `cadence: 'day'` is the exception, and the
  // reasoning above is why: the objection is about resolving a threshold
  // per SAMPLE. Day cadence compares one value per day against a stored
  // baseline that is stable for the whole window, so there is a correct
  // shape — see buildDayCadence.
  if (rule.target.type === 'baseline_offset' && rule.cadence === 'day')
    return

  if (rule.target.type === 'baseline_percent' || rule.target.type === 'baseline_stddev') {
    throw new RuleValidationError(
      `Rule ${rule.id}: consecutive is not supported with target.type `
      + `'${rule.target.type}' — baseline targets resolve per-window, not `
      + `per-sample. Use absolute or user_setting, or drop consecutive.`,
    )
  }

  const cadence = METRIC_METADATA[rule.metric].sampling_minutes
  if (cadence === 'per_session') {
    // One value per night; "consecutive samples" means consecutive nights,
    // which the window already bounds.
    return
  }

  const needed = minimumWindowMinutes(cadence, n)
  const available = WINDOW_MINUTES[rule.window]
  if (needed !== null && needed > available) {
    throw new RuleValidationError(
      `Rule ${rule.id}: consecutive ${n} x ${cadence}min sampling needs `
      + `${needed}min but window ${rule.window} is only ${available}min. `
      + `The rule could never fire. Widen the window or lower consecutive.`,
    )
  }
}

/**
 * T-21 — context compatibility.
 *
 * `context: 'asleep'` JOINs `v_sleep_session` on the metric's `ts`, so a
 * metric whose own time axis IS the sleep session (sleep_total_minutes)
 * would self-join meaninglessly.
 */
function validateContext(rule: Rule): void {
  if (rule.context === 'any')
    return
  const table = METRIC_METADATA[rule.metric].table
  if (table === 'sleep_session') {
    throw new RuleValidationError(
      `Rule ${rule.id}: context '${rule.context}' is redundant for metric `
      + `${rule.metric} — it is already a per-session measure. Use context 'any'.`,
    )
  }
}

/**
 * Sprint 5 §4 / T-42 — a `user_setting` target's key must be in the
 * KVStore namespace registry.
 *
 * Without this check a typo is invisible in the worst possible way: a rule
 * pointing at `user:spo2SaveLevel` compiles, validates, evaluates, and
 * silently uses its `defaultValue` forever. The user drags their safe
 * level, sees it save, and the alert never changes behaviour — with no
 * error raised anywhere. Failing at register() turns a silent
 * misconfiguration into a loud one.
 *
 * UX-state keys are rejected too. They are in the registry so authors can
 * see the whole namespace, but thresholding a rule on "did they dismiss a
 * banner" is a bug rather than a feature.
 */
function validateUserSettingKey(rule: Rule): void {
  if (rule.target.type !== 'user_setting')
    return
  const { key } = rule.target
  if (isRuleReadableKvKey(key))
    return

  const known = ruleReadableKvKeys()
  const detail = isRegisteredKvKey(key)
    ? `'${key}' is registered but is UX state, not a threshold`
    : `'${key}' is not in the KVStore key namespace registry`
  throw new RuleValidationError(
    `Rule ${rule.id}: ${detail}. `
    + `Rule-readable keys are [${known.join(', ')}]. `
    + `Add new keys to KV_KEY_REGISTRY in @mongrov/types/kv-keys — a key `
    + `absent from the registry would silently fall back to defaultValue.`,
  )
}

/** Scan a rawSql body for whole-word references to collected-only columns. */
export function referencedCollectedOnlyColumns(sql: string): string[] {
  const hits = new Set<string>()
  for (const col of COLLECTED_ONLY_COLUMNS) {
    const pattern = new RegExp(`\\b${col}\\b`)
    if (pattern.test(sql))
      hits.add(col)
  }
  return Array.from(hits)
}
