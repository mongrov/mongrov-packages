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

  it('ziva ships the rules named in the spec (T-13 + Sprint 5 T-25/T-26)', () => {
    // Ids are load-bearing: they key throttle state at
    // `analytics:rule:{ruleId}:{userId}:*` and are cross-referenced by name
    // from the Sprint 5 catalog additions.
    expect(zivaDefaults.map(r => r.id).sort()).toEqual([
      'ziva.hrv-drop-30',
      'ziva.low-activity-week',
      'ziva.sleep-deprivation-3',
      'ziva.spo2-desaturation-asleep',
      'ziva.spo2-safe-level',
      'ziva.stress-elevated-day',
    ])
  })

  it('the two SpO₂ rules coexist and differ where it matters (Ziva #1)', () => {
    const byId = Object.fromEntries(zivaDefaults.map(r => [r.id, r]))
    const safeLevel = byId['ziva.spo2-safe-level']
    const pattern = byId['ziva.spo2-desaturation-asleep']

    // A — the loud one the ⚙ sheet promises: any single reading, day or
    // night, against the user's own threshold.
    expect(safeLevel).toMatchObject({
      metric: 'spo2',
      window: '24h',
      aggregation: 'min',
      compare: 'less_than',
      context: 'any',
      consecutive: 1,
      severity: 'warn',
      target: { type: 'user_setting', key: 'user:spo2SafeLevel', defaultValue: 90 },
    })

    // B — a secondary pattern insight, not an alert.
    expect(pattern).toMatchObject({
      metric: 'spo2',
      context: 'asleep',
      consecutive: 3,
      severity: 'info',
      target: { type: 'absolute', value: 88 },
    })

    // Independent throttle state follows from distinct ids.
    expect(safeLevel.id).not.toBe(pattern.id)
    expect(safeLevel.throttle).not.toEqual(pattern.throttle)
  })

  it('the safe-level window is 24h, not 1h — batch delivery envelope', () => {
    // A morning sync delivers ~8h of overnight readings in one batch. A
    // wall-clock 1h window would miss the 3 AM crossing the rule exists
    // to catch. Regression guard on a subtle, load-bearing choice.
    const rule = zivaDefaults.find(r => r.id === 'ziva.spo2-safe-level')!
    expect(rule.window).toBe('24h')
  })

  it('ziva defaults exercise the relative target paths, not just absolute', () => {
    // Regression guard: the catalog previously shipped four `absolute`
    // rules, leaving baseline_percent + baseline_stddev compilation with
    // zero coverage from any shipped brand.
    const byId = Object.fromEntries(zivaDefaults.map(r => [r.id, r]))

    expect(byId['ziva.hrv-drop-30'].target).toEqual({
      type: 'baseline_percent',
      windowDays: 7,
      percent: 70,
    })
    expect(byId['ziva.stress-elevated-day'].target).toEqual({
      type: 'baseline_stddev',
      windowDays: 14,
      stddevs: 1.5,
    })
    expect(byId['ziva.sleep-deprivation-3'].target).toEqual({
      type: 'absolute',
      value: 300,
    })
    expect(byId['ziva.low-activity-week']).toMatchObject({
      window: '7d',
      aggregation: 'sum',
      target: { type: 'absolute', value: 20000 },
    })
  })

  it('every target type in the schema is covered by some shipped catalog', () => {
    const shipped = new Set(
      [...zivaDefaults, ...luminxDefaults, ...vivaDefaults, ...yogaringDefaults]
        .map(r => r.target.type),
    )
    // `range` is still unused by any brand default; every other target
    // type must stay covered so no compiler path ships unexercised.
    expect(shipped).toContain('absolute')
    expect(shipped).toContain('baseline_percent')
    expect(shipped).toContain('baseline_stddev')
    expect(shipped).toContain('user_setting')
  })
})

describe('TOML catalogs ↔ bundled wrappers', () => {
  // The `.toml` files are the authored source of truth, but Metro/tsup
  // cannot resolve `.toml` imports, so each is mirrored into a template
  // literal in the sibling `.ts`. Two copies can drift silently — and did:
  // three wrappers had lost their catalog header comment. This asserts the
  // mirror is byte-exact, which is what `scripts/sync-toml.mjs` produces.
  it('each <brand>.ts embeds its <brand>.toml verbatim', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { BRANDS, spliceWrapper } = await import(
      '../../../scripts/sync-toml.mjs'
    )
    const dir = join(__dirname, '..', 'defaults')

    for (const brand of BRANDS) {
      const toml = readFileSync(join(dir, `${brand}.toml`), 'utf-8')
      const wrapper = readFileSync(join(dir, `${brand}.ts`), 'utf-8')
      expect(
        spliceWrapper(wrapper, toml),
        `${brand}.ts is stale — run: node scripts/sync-toml.mjs`,
      ).toBe(wrapper)
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
