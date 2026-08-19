/**
 * Sprint 5 T-42 — KVStore key namespace registry.
 *
 * This registry is a cross-package contract with no compile-time link: the
 * app's settings UI writes a string, the rules engine reads a string, and
 * only this list connects them. The tests below are what make that
 * connection real.
 */

import {
  isRegisteredKvKey,
  isRuleReadableKvKey,
  KV_ANALYTICS_PREFIX,
  KV_KEY_REGISTRY,
  kvKeyFor,
  ruleReadableKvKeys,
} from '../kv-keys'

describe('KV_KEY_REGISTRY', () => {
  it('registers exactly the declared surface — adding a key is deliberate', () => {
    // Closed-world on purpose. This list failing is the intended cost of
    // adding a key: the registry is the rules validator's allow-list, not
    // documentation, so growth should require a decision rather than happen.
    expect(Object.keys(KV_KEY_REGISTRY).sort()).toEqual([
      'user:hrvDropDays',
      'user:hrvDropMs',
      'user:spo2Day30BannerDismissed',
      'user:spo2Notify',
      'user:spo2SafeLevel',
      'user:stressFlagLevel',
      'user:stressNotify',
      'user:tempFlagLevel',
      'user:tempNotify',
    ])
  })

  it('numeric thresholds declare a default inside their own range', () => {
    // The pairing matters more than either value: sprint6 specified a
    // temperature flag of 37.5 over 37.2-38.1 against a column that could
    // represent neither bound distinctly. Declaring them together here is
    // what lets a settings UI and the rule catalog agree without copying.
    // Reported as one object so a failure names the offending key — jest's
    // expect() takes no message argument.
    const offenders = Object.entries(KV_KEY_REGISTRY)
      .filter(([, e]) => e.kind === 'threshold')
      .filter(([, e]) => {
        if (typeof e.defaultValue !== 'number' || !e.range)
          return true
        const [min, max] = e.range
        return min >= max || e.defaultValue < min || e.defaultValue > max
      })
      .map(([k]) => k)

    expect(offenders).toEqual([])
  })

  it('every entry declares kind, valueType and a description', () => {
    for (const entry of Object.values(KV_KEY_REGISTRY)) {
      expect(['threshold', 'ux_state']).toContain(entry.kind)
      expect(['number', 'boolean', 'string']).toContain(entry.valueType)
      expect(entry.description.length).toBeGreaterThan(10)
    }
  })

  it('keys use the documented user:{setting} shape', () => {
    for (const key of Object.keys(KV_KEY_REGISTRY)) {
      expect(key).toMatch(/^user:[a-zA-Z0-9]+$/)
    }
  })
})

describe('rule readability', () => {
  it('only threshold keys are rule-readable', () => {
    expect(isRuleReadableKvKey('user:spo2SafeLevel')).toBe(true)
    // UX state is registered but not something a rule should threshold on.
    expect(isRegisteredKvKey('user:spo2Notify')).toBe(true)
    expect(isRuleReadableKvKey('user:spo2Notify')).toBe(false)
  })

  it('unknown keys are neither', () => {
    expect(isRegisteredKvKey('user:spo2SaveLevel')).toBe(false)
    expect(isRuleReadableKvKey('user:spo2SaveLevel')).toBe(false)
  })

  it('ruleReadableKvKeys lists exactly the thresholds', () => {
    expect(ruleReadableKvKeys().sort()).toEqual([
      'user:hrvDropDays',
      'user:hrvDropMs',
      'user:spo2SafeLevel',
      'user:stressFlagLevel',
      'user:tempFlagLevel',
    ])
    // Notification toggles are ux_state — a rule thresholding on "did they
    // opt in to notifications" is a bug, not a feature.
    expect(ruleReadableKvKeys()).not.toContain('user:tempNotify')
  })
})

describe('kvKeyFor', () => {
  it('builds the full per-user path the evaluator reads', () => {
    expect(kvKeyFor('alice', 'user:spo2SafeLevel'))
      .toBe('analytics:alice:user:spo2SafeLevel')
  })

  it('scopes per user, so family members hold independent settings', () => {
    expect(kvKeyFor('alice', 'user:spo2SafeLevel'))
      .not
      .toBe(kvKeyFor('bob', 'user:spo2SafeLevel'))
  })

  it('uses the analytics prefix', () => {
    expect(kvKeyFor('u', 'user:x').startsWith(`${KV_ANALYTICS_PREFIX}:`)).toBe(true)
  })
})
