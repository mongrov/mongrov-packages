/**
 * KVStore key namespace registry (Sprint 5 §32 / T-42, principle 29).
 *
 * A rule with `target.type: 'user_setting'` reads its threshold from
 * KVStore at evaluation time. That makes the key a **cross-package
 * contract**: the app's settings UI writes it, `@mongrov/analytics/rules`
 * reads it, and nothing in TypeScript connects the two — they agree only
 * on a string.
 *
 * Which means a typo is invisible in the worst way. A rule pointing at
 * `user:spo2SaveLevel` compiles, validates, evaluates, and quietly uses its
 * `defaultValue` forever. The user drags their safe level, sees it save,
 * and the alert never changes behaviour. No error anywhere.
 *
 * So the registry is not documentation — it is the allow-list the rules
 * validator checks against, and adding a key here is a deliberate step.
 *
 * ## Full key shape
 *
 * Rules store `key` as the SUFFIX only. The evaluator resolves the full
 * KVStore path by prefixing the user:
 *
 * ```
 * analytics:{userId}:{key}
 * analytics:alice:user:spo2SafeLevel
 * ```
 *
 * The `analytics:` prefix keeps these out of the way of other packages'
 * KVStore usage; the `{userId}` segment is what makes two family members
 * on one device hold independent settings.
 */

/**
 * Every KVStore key a `user_setting` rule target may reference.
 *
 * Grouped by what writes them:
 *
 * - **Thresholds** — written by a settings UI, read by the rules engine at
 *   eval time. These are the only keys `user_setting` targets should point
 *   at.
 * - **UX state** — written and read by the app only. Listed here because
 *   they share the namespace and a future rule author needs to see the
 *   whole space to avoid collisions, not because a rule should read them.
 */
export const KV_KEY_REGISTRY = {
  /** Ziva SpO₂ safe level, 86–94. Written by the ⚙ sheet's Save button. */
  'user:spo2SafeLevel': {
    kind: 'threshold',
    valueType: 'number',
    description: 'SpO₂ percentage below which the safe-level rule fires',
    usedBy: ['ziva.spo2-safe-level'],
    defaultValue: 90,
    range: [86, 94],
  },
  /** Whether SpO₂ violations raise a notification. UX state, not a threshold. */
  'user:spo2Notify': {
    kind: 'ux_state',
    valueType: 'boolean',
    description: 'User opted in to SpO₂ notifications',
    usedBy: [],
  },
  /** One-time banner dismissal. Deliberately NOT an insight row. */
  'user:spo2Day30BannerDismissed': {
    kind: 'ux_state',
    valueType: 'boolean',
    description: 'User dismissed the day-30 baseline-ready banner',
    usedBy: [],
  },

  // ── sprint6: temperature (T-06) ───────────────────────────────────────
  /**
   * Canonical °C, never °F. The screen converts for display; storing the
   * display unit would make the same number mean different things to two
   * users. Fractional on purpose — `temperature.temp_c` is DECIMAL(4,1) as
   * of analytics 0.9.1 precisely so this range discriminates.
   */
  'user:tempFlagLevel': {
    kind: 'threshold',
    valueType: 'number',
    description: 'Temperature in °C at or above which the temp flag rule fires',
    usedBy: ['ziva.temp-flag-level'],
    defaultValue: 37.5,
    range: [37.2, 38.1],
    step: 0.1,
  },
  'user:tempNotify': {
    kind: 'ux_state',
    valueType: 'boolean',
    description: 'User opted in to temperature notifications',
    usedBy: [],
    defaultValue: true,
  },

  // ── sprint6: stress (D-E) ─────────────────────────────────────────────
  /**
   * Stress gets an absolute draggable flag where HRV cannot, and the reason
   * is not arbitrary: stress is a vendor-normalised 0-100 score whose rails
   * the user already sees on the screen, so 66 means the same thing for
   * everyone. HRV's absolute value does not.
   *
   * The default sits exactly on the Tense rail (`tense >= 66` in
   * STRESS_CONFIG). That rail is inclusive, which is why the rule compares
   * with `greater_than_or_equal` — at the default, a reading the chart paints
   * Tense must also be a reading the alert counts.
   *
   * The range stops short of both ends of the scale. Below 50 the flag would
   * fire on ordinary Balanced days; the top stops at 85 rather than at 100
   * because a flag set in the 90s would effectively never fire and the
   * control would read as broken.
   */
  'user:stressFlagLevel': {
    kind: 'threshold',
    valueType: 'number',
    description: 'Stress score at or above which the stress flag rule fires',
    usedBy: ['ziva.stress-flag-level'],
    defaultValue: 66,
    range: [50, 85],
    step: 1,
  },
  'user:stressNotify': {
    kind: 'ux_state',
    valueType: 'boolean',
    description: 'User opted in to stress notifications',
    usedBy: [],
    defaultValue: true,
  },

  // ── sprint6: heart rate (D-G) ─────────────────────────────────────────
  /**
   * The high-side resting flag, in bpm.
   *
   * "High-only v1" — there is deliberately no low-side control. A low resting
   * rate is usually fitness rather than a problem, and an alert on it would be
   * wrong far more often than right.
   *
   * The step is 5, not 1. Resting heart rate is not meaningful at 1-bpm
   * resolution and a finer control would imply a precision the measurement
   * does not have.
   *
   * The rule behind this is resting-GATED: only readings with no movement
   * within +/-15 min can fire it, so an exercise peak of 160 never alerts.
   * That gate is `context: 'resting'`, corrected in analytics 0.20.0.
   */
  'user:hrFlagLevel': {
    kind: 'threshold',
    valueType: 'number',
    description: 'Resting heart rate in bpm at or above which the HR flag rule fires',
    usedBy: ['ziva.hr-flag-level'],
    defaultValue: 100,
    range: [80, 120],
    step: 5,
  },
  'user:hrNotify': {
    kind: 'ux_state',
    valueType: 'boolean',
    description: 'User opted in to heart rate notifications',
    usedBy: [],
    defaultValue: true,
  },

  // ── sprint6: HRV (T-06) ───────────────────────────────────────────────
  /**
   * A DROP in milliseconds below the user's own baseline, not an absolute
   * HRV floor. HRV has no meaningful absolute threshold — `ziva.hrv-below-usual`
   * is relative-only by locked decision D3, and the rules validator rejects
   * an absolute-threshold rule on `hrv_ms`.
   */
  'user:hrvDropMs': {
    kind: 'threshold',
    valueType: 'number',
    description: 'Milliseconds below baseline p50 that counts as an HRV drop',
    usedBy: ['ziva.hrv-below-usual'],
    defaultValue: 10,
    range: [5, 25],
    step: 1,
  },
  /** Consecutive DAYS the drop must persist. Cadence is days, not readings. */
  'user:hrvDropDays': {
    kind: 'threshold',
    valueType: 'number',
    description: 'Consecutive days an HRV drop must persist before firing',
    usedBy: ['ziva.hrv-below-usual'],
    defaultValue: 3,
    range: [2, 7],
    step: 1,
  },
} as const satisfies Record<string, KvKeyEntry>

export interface KvKeyEntry {
  /**
   * `threshold` keys are readable by `user_setting` rule targets.
   * `ux_state` keys are app-only and rejected by the rules validator — a
   * rule thresholding on "did they dismiss a banner" is a bug, not a
   * feature.
   */
  kind: 'threshold' | 'ux_state'
  valueType: 'number' | 'boolean' | 'string'
  description: string
  /** Rule ids known to read this key. Documentation, not enforcement. */
  usedBy: readonly string[]
  /**
   * Value used when the key is unset.
   *
   * Declared here so the rule catalog, the settings UI and the evaluator's
   * fallback cannot disagree. `spo2SafeLevel`'s range lived only in a prose
   * comment on this file until sprint6, which is how the temperature flag
   * came to be specified over a range its column could not represent.
   */
  defaultValue?: number | boolean | string
  /** Inclusive bounds a settings UI must clamp to. Numeric keys only. */
  range?: readonly [min: number, max: number]
  /** Smallest meaningful increment, where the UI steps rather than slides. */
  step?: number
}

export type KvKey = keyof typeof KV_KEY_REGISTRY

/** KVStore prefix owned by the analytics plane. */
export const KV_ANALYTICS_PREFIX = 'analytics'

/** Resolve a registry key to its full per-user KVStore path. */
export function kvKeyFor(userId: string, key: string): string {
  return `${KV_ANALYTICS_PREFIX}:${userId}:${key}`
}

/** Is this a registered key at all? */
export function isRegisteredKvKey(key: string): key is KvKey {
  return Object.prototype.hasOwnProperty.call(KV_KEY_REGISTRY, key)
}

/**
 * May a `user_setting` rule target read this key?
 *
 * Registered AND `kind: 'threshold'`. UX-state keys are in the registry so
 * authors can see the whole namespace, but pointing a rule at one is
 * rejected.
 */
export function isRuleReadableKvKey(key: string): key is KvKey {
  return isRegisteredKvKey(key) && KV_KEY_REGISTRY[key].kind === 'threshold'
}

/** Every key a rule may legally reference. Used in validator error text. */
export function ruleReadableKvKeys(): KvKey[] {
  return (Object.keys(KV_KEY_REGISTRY) as KvKey[]).filter(isRuleReadableKvKey)
}
