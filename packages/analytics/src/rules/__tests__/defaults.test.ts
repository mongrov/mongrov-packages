import { describe, expect, it } from 'vitest'
import {
  luminxDefaults,
  parseCatalog,
  vivaDefaults,
  yogaringDefaults,
  zivaDefaults,
} from '../defaults'
import { RuleValidationError } from '../schema'
import { validateRule } from '../validator'

describe('brand default catalogs', () => {
  it('ziva ships >= 4 valid rules', () => {
    expect(zivaDefaults.length).toBeGreaterThanOrEqual(4)
    for (const rule of zivaDefaults) {
      expect(() => validateRule(rule)).not.toThrow()
      expect(rule.brand).toBe('ziva')
    }
  })

  it('luminx ships >= 3 valid rules', () => {
    expect(luminxDefaults.length).toBeGreaterThanOrEqual(3)
    for (const rule of luminxDefaults) {
      expect(() => validateRule(rule)).not.toThrow()
      expect(rule.brand).toBe('luminx')
    }
  })

  it('viva ships >= 2 valid rules', () => {
    expect(vivaDefaults.length).toBeGreaterThanOrEqual(2)
    for (const rule of vivaDefaults) {
      expect(() => validateRule(rule)).not.toThrow()
      expect(rule.brand).toBe('viva')
    }
  })

  it('yogaring ships >= 2 valid rules', () => {
    expect(yogaringDefaults.length).toBeGreaterThanOrEqual(2)
    for (const rule of yogaringDefaults) {
      expect(() => validateRule(rule)).not.toThrow()
      expect(rule.brand).toBe('yogaring')
    }
  })

  it('rule ids are unique per brand', () => {
    const collect = (rules: { id: string }[]): string[] => rules.map(r => r.id)
    for (const list of [zivaDefaults, luminxDefaults, vivaDefaults, yogaringDefaults]) {
      const ids = collect(list)
      const unique = new Set(ids)
      expect(unique.size).toBe(ids.length)
    }
  })
})

describe('parseCatalog', () => {
  it('parses a minimal valid TOML doc', () => {
    const toml = `
[[rule]]
id = "x.simple"
name = "Simple"
metric = "hrv_ms"
window = "24h"
aggregation = "avg"
compare = "less_than"
severity = "info"

[rule.target]
type = "absolute"
value = 40
`
    const rules = parseCatalog(toml, { name: 'x' })
    expect(rules).toHaveLength(1)
    expect(rules[0].id).toBe('x.simple')
  })

  it('throws RuleValidationError on TOML syntax error', () => {
    expect(() => parseCatalog('not = valid = toml', { name: 'bad' }))
      .toThrow(RuleValidationError)
  })

  it('throws RuleValidationError on missing [[rule]] entries', () => {
    expect(() => parseCatalog('title = "empty"', { name: 'empty' }))
      .toThrow(/missing \[\[rule\]\]/)
  })

  it('throws RuleValidationError with rule index on bad rule', () => {
    const toml = `
[[rule]]
id = "ok"
name = "ok"
metric = "hrv_ms"
window = "24h"
aggregation = "avg"
compare = "less_than"
severity = "warn"
[rule.target]
type = "absolute"
value = 40

[[rule]]
id = "bad"
name = "bad"
metric = "not_a_real_metric"
window = "24h"
aggregation = "avg"
compare = "less_than"
severity = "warn"
[rule.target]
type = "absolute"
value = 1
`
    expect(() => parseCatalog(toml, { name: 'x' }))
      .toThrow(/rule 1/)
  })
})
