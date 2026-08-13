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
  it('registers the keys the Ziva SpO₂ surface uses', () => {
    expect(Object.keys(KV_KEY_REGISTRY).sort()).toEqual([
      'user:spo2Day30BannerDismissed',
      'user:spo2Notify',
      'user:spo2SafeLevel',
    ])
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
    expect(ruleReadableKvKeys()).toEqual(['user:spo2SafeLevel'])
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
