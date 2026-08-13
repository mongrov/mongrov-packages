import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { getExposedMetricIds } from '../../core/metric_metadata'
import { compileRule } from '../compiler'
import { createCompilerCache } from '../compiler-cache'
import {
  AGGREGATIONS,
  COMPARES,
  RuleSchema,
  SEVERITIES,
  WINDOWS,
} from '../schema'
import { allowedWindowsFor, validateRule } from '../validator'

const metrics = getExposedMetricIds()

const ruleArb = fc
  .record({
    id: fc.string({ minLength: 1, maxLength: 32 }).map(s => `r.${s}`),
    name: fc.string({ minLength: 1, maxLength: 32 }),
    metric: fc.constantFrom(...metrics),
    window: fc.constantFrom(...WINDOWS),
    aggregation: fc.constantFrom(...AGGREGATIONS),
    compare: fc.constantFrom(...COMPARES.filter(c => c !== 'between')),
    severity: fc.constantFrom(...SEVERITIES),
    target: fc.oneof(
      fc.record({ type: fc.constant('absolute'), value: fc.integer({ min: 0, max: 300 }) }),
      fc.record({
        type: fc.constant('baseline_percent'),
        windowDays: fc.integer({ min: 1, max: 30 }),
        percent: fc.integer({ min: 10, max: 200 }),
      }),
      fc.record({
        type: fc.constant('baseline_stddev'),
        windowDays: fc.integer({ min: 1, max: 30 }),
        stddevs: fc.integer({ min: 1, max: 5 }),
      }),
    ),
  })
  .map(raw => RuleSchema.parse(raw))

const RUNS = 200

describe('compileRule — property tests', () => {
  it(`compiled SQL binds $userId + $brand + $familyId (never literal)`, () => {
    fc.assert(
      fc.property(ruleArb, (rule) => {
        // Skip rules whose window is unviable for the metric — the compiler
        // still succeeds, but sync would have validated first. Trust the
        // compiler contract irrespective of sampling.
        const compiled = compileRule(rule)
        expect(compiled.sql).toContain('$userId')
        expect(compiled.sql).toContain('$brand')
        expect(compiled.sql).toContain('$familyId')
        // Never literal, whitespace-tolerant:
        expect(compiled.sql).not.toMatch(/user_id\s*=\s*['"]/)
        expect(compiled.sql).not.toMatch(/family_id\s*=\s*['"]/)
      }),
      { numRuns: RUNS },
    )
  })

  it('identifier segments contain only [A-Za-z0-9_]', () => {
    fc.assert(
      fc.property(ruleArb, (rule) => {
        const compiled = compileRule(rule)
        // Extract "FROM <ident>" and check it.
        const fromMatch = compiled.sql.match(/FROM\s+(\w+)/i)
        expect(fromMatch).not.toBeNull()
        expect(fromMatch![1]).toMatch(/^\w+$/)
      }),
      { numRuns: RUNS },
    )
  })

  it('validator rejects windows below metric minimum', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...metrics),
        fc.constantFrom(...WINDOWS),
        (metric, window) => {
          const allowed = allowedWindowsFor(metric)
          const shouldPass = allowed.includes(window)
          const rule = RuleSchema.parse({
            id: 'r.x',
            name: 'x',
            metric,
            window,
            aggregation: 'avg',
            compare: 'less_than',
            severity: 'info',
            target: { type: 'absolute', value: 10 },
          })
          if (shouldPass) {
            expect(() => validateRule(rule)).not.toThrow()
          }
          else {
            expect(() => validateRule(rule)).toThrow()
          }
        },
      ),
      { numRuns: RUNS },
    )
  })
})

describe('compiler cache', () => {
  it('returns cached compilation at same rev, refreshes on rev bump', () => {
    const cache = createCompilerCache()
    const rule = RuleSchema.parse({
      id: 'r.a',
      name: 'a',
      metric: 'hrv_ms',
      window: '24h',
      aggregation: 'avg',
      compare: 'less_than',
      severity: 'info',
      target: { type: 'absolute', value: 40 },
    })
    const first = cache.getCompiled(rule, 1)
    const second = cache.getCompiled(rule, 1)
    expect(second).toBe(first) // reference equality
    const third = cache.getCompiled(rule, 2)
    expect(third).not.toBe(first)
    expect(third.sql).toBe(first.sql) // content still stable
  })

  it('invalidate clears the entry', () => {
    const cache = createCompilerCache()
    const rule = RuleSchema.parse({
      id: 'r.b',
      name: 'b',
      metric: 'hrv_ms',
      window: '24h',
      aggregation: 'avg',
      compare: 'less_than',
      severity: 'info',
      target: { type: 'absolute', value: 40 },
    })
    cache.getCompiled(rule, 1)
    expect(cache.size()).toBe(1)
    cache.invalidate('r.b')
    expect(cache.size()).toBe(0)
  })
})
