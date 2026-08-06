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
