/**
 * Static validation for rules — sampling-minimum + rawSql exposure check.
 *
 * Called at `register()` time (before compilation). Fails fast with a
 * `RuleValidationError` whose message includes the metric's sampling
 * cadence + the minimum viable window.
 */

import type { MetricSampling } from '../core/metrics'
import type { RulePack, RuleSettings } from '../core/packs'
import type { Rule, Window } from './schema'
import type { RulesLogger } from './types'
import { collectedOnlyColumns, metricDefinition, samplingLabelFor } from '../core/metrics'
import { packExtensions } from '../core/packs'
import { RuleValidationError, WINDOWS } from './schema'

function rulePacks(): RulePack[] {
  return packExtensions<RulePack>('rules')
}

/** The first registered settings registry rules may read. */
function settings(): RuleSettings | undefined {
  return rulePacks().find(p => p.settings)?.settings
}

/** `consecutive x sampling` in minutes, or null for per-session metrics. */
function minimumWindowMinutes(sampling: MetricSampling, consecutive: number): number | null {
  if (sampling === 'per_session')
    return null
  return sampling * Math.max(1, consecutive)
}

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
 * Allow-list of windows compatible with `metric.sampling_minutes`.
 * A window is compatible iff its duration ≥ (2 × sampling cadence),
 * i.e. the query is guaranteed to see at least two samples worst-case.
 * `per_session` metrics (one value per session) require ≥ 3d.
 */
export function allowedWindowsFor(metric: string): Window[] {
  const explicit = rulePacks().find(p => p.windows?.[metric])?.windows?.[metric]
  if (explicit)
    return [...explicit] as Window[]
  const cadence = metricDefinition(metric)?.sampling_minutes ?? 'per_session'
  if (cadence === 'per_session') {
    return ['3d', '7d', '30d']
  }
  const minWindow = cadence * 2
  return WINDOWS.filter(w => WINDOW_MINUTES[w] >= minWindow)
}

function samplingLabel(metric: string): string {
  return samplingLabelFor(metric)
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
  validateMinDays(rule)
  for (const pack of rulePacks()) pack.validate?.(rule)
  validateUserSettingKey(rule)
  validatePhaseBand(rule)

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
 * A rule asking for 3 consecutive samples (60-min cadence) inside a 1h
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
 * Admission policy, checked at REGISTRATION rather than inside
 * `validateRule`: `validateRule` answers "is this rule well-formed?", a
 * structural question; this answers "may this rule enter the system?", a
 * product decision the packs make (`pack.rules.admit`).
 */
export function assertRegistrable(rule: Rule): void {
  for (const pack of rulePacks()) pack.admit?.(rule)
}

/** Days in each day-sized window; hour windows cannot hold a day count. */
const WINDOW_DAYS: Readonly<Record<string, number>> = { '3d': 3, '7d': 7, '30d': 30 }

/**
 * QA #108 — `minDays` counts distinct local days inside the window, so it
 * needs a window measured in days, cannot exceed it, and is compiled only on
 * the window-aggregate path.
 */
function validateMinDays(rule: Rule): void {
  const n = rule.minDays
  if (n === undefined)
    return
  const days = WINDOW_DAYS[rule.window]
  if (days === undefined) {
    throw new RuleValidationError(
      `Rule ${rule.id}: minDays needs a window measured in days (got ${rule.window}).`,
    )
  }
  if (n > days) {
    throw new RuleValidationError(
      `Rule ${rule.id}: minDays ${n} exceeds the ${rule.window} window — the rule could never fire.`,
    )
  }
  if (rule.cadence === 'day' || (rule.consecutive ?? 1) > 1 || rule.rawSql) {
    throw new RuleValidationError(
      `Rule ${rule.id}: minDays applies to window aggregates only — not with cadence 'day', `
      + `consecutive runs, or rawSql.`,
    )
  }
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

  // The window is how far back COMPLETED days are read, and today is
  // excluded, so it must hold the longest run the rule can ask for plus
  // today. A shipped flag rule with a 24h window and a 2-day run:
  // valid by every other check, and unable ever to fire.
  // A consecutiveKey can raise the count at eval time, so its registered
  // range's upper bound is the run that must fit.
  const longest = rule.consecutiveKey === undefined
    ? n
    : Math.max(n, consecutiveKeyMax(rule.consecutiveKey) ?? n)
  const days = WINDOW_DAYS[rule.window]
  if (days === undefined || days < longest + 1) {
    throw new RuleValidationError(
      `Rule ${rule.id}: cadence 'day' reads completed days inside the window, and a `
      + `${longest}-day run needs a window of at least ${longest + 1} days `
      + `(got ${rule.window}) — the rule could never fire.`,
    )
  }
}

/** Upper bound of a registered KV key's range, when it declares one. */
function consecutiveKeyMax(key: string): number | undefined {
  return settings()?.range?.(key)?.[1]
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

  const cadence = metricDefinition(rule.metric)?.sampling_minutes ?? 'per_session'
  if (cadence === 'per_session') {
    // One value per session; "consecutive samples" means consecutive
    // sessions, which the window already bounds.
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
 * Sprint 5 §4 / T-42 — a `user_setting` target's key must be in the
 * KVStore namespace registry.
 *
 * Without this check a typo is invisible in the worst possible way: a rule
 * pointing at `user:safeLevle` (a typo for `user:safeLevel`) compiles, validates, evaluates, and
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
  const registry = settings()
  if (registry?.readable(key))
    return

  const known = registry?.readableKeys() ?? []
  const detail = registry?.registered(key)
    ? `'${key}' is registered but is UX state, not a threshold`
    : `'${key}' is not in the KVStore key namespace registry`
  throw new RuleValidationError(
    `Rule ${rule.id}: ${detail}. `
    + `Rule-readable keys are [${known.join(', ')}]. `
    + `Add new keys to ${registry?.registryName ?? 'a pack\'s settings registry'} — a key `
    + `absent from the registry would silently fall back to defaultValue.`,
  )
}

/**
 * A `phase_band` target is a per-reading comparison against a band, so
 * it needs a run of readings (`consecutive >= 2`, reading cadence). Its scale
 * key must be a registered STRING setting: the value is a sensitivity name,
 * looked up in `scales`. A threshold key would be a number, and every name
 * lookup would miss and fall back to the default forever.
 */
function validatePhaseBand(rule: Rule): void {
  const t = rule.target
  if (t.type !== 'phase_band')
    return
  const fail = (msg: string): never => {
    throw new RuleValidationError(`Rule ${rule.id}: ${msg}`)
  }
  if (rule.cadence !== 'reading' || (rule.consecutive ?? 1) < 2)
    fail(`phase_band needs reading cadence and consecutive >= 2.`)
  /*
   * The default rails are OPTIONAL, and omitting them is what makes a rule
   * silent until the user has a band of their own — the same discipline every
   * screen follows (principle 27).
   *
   * Both or neither: a rule with one rail would compare against a half-open
   * range nobody wrote down. Checked here rather than in the schema because a
   * `.refine()` makes the target a ZodEffects, which `z.discriminatedUnion`
   * cannot hold.
   */
  const hasLo = t.defaultLo !== undefined
  const hasHi = t.defaultHi !== undefined
  if (hasLo !== hasHi)
    fail(`phase_band: defaultLo and defaultHi must be given together, or both omitted.`)
  if (hasLo && hasHi && !(t.defaultLo! < t.defaultHi!))
    fail(`phase_band defaultLo (${t.defaultLo}) must be below defaultHi (${t.defaultHi}).`)
  if (t.scaleKey !== undefined) {
    const key = t.scaleKey
    const registry = settings()
    if (!registry?.registered(key))
      fail(`'${key}' is not in the KVStore key namespace registry.`)
    if (registry?.valueType(key) !== 'string')
      fail(`scaleKey '${key}' must be a string setting naming a sensitivity.`)
    if (t.scales === undefined || Object.keys(t.scales).length === 0)
      fail(`scaleKey '${key}' needs a non-empty scales map.`)
  }
  if (t.defaultScale !== undefined && t.scales?.[t.defaultScale] === undefined)
    fail(`defaultScale '${t.defaultScale}' is not a key of scales.`)
}

/** Scan a rawSql body for whole-word references to collected-only columns. */
export function referencedCollectedOnlyColumns(sql: string): string[] {
  const hits = new Set<string>()
  for (const col of collectedOnlyColumns()) {
    const pattern = new RegExp(`\\b${col}\\b`)
    if (pattern.test(sql))
      hits.add(col)
  }
  return Array.from(hits)
}
