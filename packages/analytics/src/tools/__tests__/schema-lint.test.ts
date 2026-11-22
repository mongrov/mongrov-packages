/**
 * Input schemas through the on-device bridge's converter.
 *
 * `parseLikeAppleBridge` replicates `AppleLLMSchemaParser`
 * (`@react-native-ai/apple` 0.12, `ios/AppleLLMImpl.swift`), which cannot run
 * in node. A schema it rejects fails the whole request, every tool with it.
 * These cases pin each of its rules, then put every tool the platform ships
 * and the framework's test tools through `toJsonSchemaObject` (the exact
 * converter the framework hands the AI SDK) and the replica — zod 3 and 4.
 */

import { createRequire } from 'node:module'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z as z3 } from 'zod'
import * as zod4 from 'zod/v4'
import { getPacks, packExtensions, resetPacks } from '../../core/packs'
import { defineTool, lintToolDefinition } from '../define'
import { toJsonSchemaObject } from '../json-schema'
import { lintToolInputSchema, parseLikeAppleBridge } from '../schema-lint'
import { SeriesInput, SeriesOutput } from './support/structured'

const z4 = zod4.z

beforeAll(() => {
  const root = createRequire(import.meta.url)('zod') as { toJSONSchema?: unknown }
  root.toJSONSchema ??= zod4.toJSONSchema
})

afterEach(() => resetPacks())

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required })

describe('parseLikeAppleBridge (the bridge\'s rules)', () => {
  it.each([
    ['a null type', obj({ a: { type: 'null' } }), 'Unsupported schema type: null'],
    ['a type list (.nullable())', obj({ a: { type: ['string', 'null'] } }), 'Unsupported schema type: unknown'],
    ['a $ref', obj({ a: { $ref: '#/definitions/x' } }), 'Unsupported schema type: unknown'],
    ['oneOf', obj({ a: { oneOf: [{ type: 'string' }] } }), 'Unsupported schema type: unknown'],
    ['an empty schema (z.any())', obj({ a: {} }), 'Unsupported schema type: unknown'],
    ['multipleOf', obj({ a: { type: 'number', multipleOf: 5 } }), 'MultipleOf is not supported'],
    ['an array without items', obj({ a: { type: 'array' } }), 'Array schema must have items definition'],
    ['a bad pattern', obj({ a: { type: 'string', pattern: '(' } }), 'Invalid regex pattern'],
    ['a null member of anyOf', obj({ a: { anyOf: [{ type: 'string' }, { type: 'null' }] } }), 'Unsupported schema type: null'],
  ])('throws on %s', (_case, schema, message) => {
    expect(parseLikeAppleBridge(schema).error).toContain(message)
  })

  it.each([
    ['min and max: only the maximum is kept', { type: 'integer', minimum: 1, maximum: 30 }, ['a.minimum']],
    ['min alone is kept', { type: 'integer', minimum: 1 }, []],
    ['a numeric enum is read only as strings', { type: 'integer', enum: [1, 2] }, ['a.enum']],
    ['format and minLength are ignored', { type: 'string', format: 'date', minLength: 2 }, ['a.format', 'a.minLength']],
    ['a string enum is kept', { type: 'string', enum: ['x', 'y'] }, []],
    ['a pattern is kept', { type: 'string', pattern: '^\\d{4}$' }, []],
  ])('%s', (_case, prop, lost) => {
    const r = parseLikeAppleBridge(obj({ a: prop }))
    expect(r.error).toBeNull()
    expect(r.lost).toEqual(lost)
  })
})

describe('lintToolInputSchema', () => {
  const rules = (schema: Record<string, unknown>, level: 'error' | 'warning' = 'error') =>
    lintToolInputSchema(schema).filter(i => i.level === level).map(i => `${i.path}:${i.rule}`)

  it('a clean schema of enums, an optional pattern-checked string and a host id has no issue', () => {
    const schema = toJsonSchemaObject(z3.object({
      userId: z3.string(),
      kind: z3.enum(['a', 'b']),
      day: z3.string().regex(/^(today|yesterday|\d{4}-\d{2}-\d{2})$/).optional().describe('today, yesterday or YYYY-MM-DD'),
      compare: z3.enum(['none', 'previous_period']).optional(),
    }))
    expect(lintToolInputSchema(schema)).toEqual([])
  })

  it.each([
    ['a nullable field', z3.object({ a: z3.string().nullable() }), ['a:type-array', ':bridge-throws']],
    ['a range', z3.object({ a: z3.number().int().min(1).max(30) }), ['a:both-bounds']],
    ['multipleOf', z3.object({ a: z3.number().multipleOf(5) }), ['a:multiple-of']],
    ['a nested object', z3.object({ a: z3.object({ b: z3.string() }) }), ['a:nesting']],
    ['an array of objects', z3.object({ a: z3.array(z3.object({ b: z3.string() })) }), ['a:nesting']],
    ['a union of numbers', z3.object({ a: z3.union([z3.literal(1), z3.literal(2)]) }), ['a:numeric-enum']],
  ])('errors on %s', (_case, schema, expected) => {
    const found = rules(toJsonSchemaObject(schema as never))
    for (const e of expected)
      expect(found).toContain(e)
  })

  it('a union of a string and a number is rejected', () => {
    expect(rules(obj({ a: { anyOf: [{ type: 'string' }, { type: 'number' }] } }))).toContain('a:union')
  })

  it('a root that is not an object is an error', () => {
    expect(rules({ type: 'string' })).toEqual([':root-object'])
  })

  it('x-boundsCheckedBy: framework allows a range (the framework re-validates the minimum)', () => {
    expect(rules(obj({ a: { 'type': 'integer', 'minimum': 1, 'maximum': 9, 'x-boundsCheckedBy': 'framework' } }))).toEqual([])
  })

  it('a pattern outside the portable subset is an error', () => {
    expect(rules(obj({ a: { type: 'string', pattern: '(?<=x)y' } }))).toContain('a:pattern-portable')
  })

  it('warns on a long field description, more than 5 fields, and ignored keywords', () => {
    const warnings = rules(obj({
      a: { type: 'string', description: 'x'.repeat(61) },
      b: { type: 'string', format: 'date' },
      c: { type: 'string' },
      d: { type: 'string' },
      e: { type: 'string' },
      f: { type: 'string' },
    }), 'warning')
    expect(warnings).toEqual(expect.arrayContaining(['a:field-description', ':property-count', 'b:ignored-keyword']))
  })

  it.each([
    ['zod 3', z3.object({ a: z3.string().nullable() })],
    ['zod 4', z4.object({ a: z4.string().nullable() })],
  ])('the nullable error holds for %s', (_zod, schema) => {
    expect(lintToolInputSchema(toJsonSchemaObject(schema as never)).some(i => i.level === 'error')).toBe(true)
  })
})

describe('defineTool', () => {
  const base = {
    name: 'getSeries',
    description: 'Daily values over a period.',
    inputSchema: SeriesInput,
    outputSchema: SeriesOutput,
    impl: async () => { throw new Error('unused') },
  }

  it('returns the definition unchanged when it passes', () => {
    const def = defineTool(base)
    expect(def).toBe(base)
  })

  it('throws under a test runner on a lint error (here: a nullable input)', () => {
    expect(() => defineTool({ ...base, inputSchema: z3.object({ a: z3.string().nullable() }) })).toThrow(/tool "getSeries": .*a: a type list/)
  })

  it('throws on a bad name', () => {
    expect(() => defineTool({ ...base, name: 'Get-Series' })).toThrow(/must match/)
  })

  it('a missing outputSchema or a long description is a warning only', () => {
    const issues = lintToolDefinition({ ...base, outputSchema: undefined, description: 'x'.repeat(201) })
    expect(issues.map(i => `${i.level}:${i.rule}`)).toEqual(['warning:description', 'warning:output-schema'])
    expect(() => defineTool({ ...base, outputSchema: undefined, description: 'x'.repeat(201) })).not.toThrow()
  })
})

describe('every schema the package ships survives the bridge', () => {
  it('the platform\'s tools and the test tools, through toJsonSchemaObject: the bridge never throws', () => {
    expect(getPacks().map(p => p.name)).toContain('platform')
    const tools = {
      ...Object.assign({}, ...packExtensions<Record<string, { inputSchema: never }>>('tools')),
      getSeries: { inputSchema: SeriesInput },
      getSeries4: { inputSchema: z4.object({ userId: z4.string(), period: z4.enum(['this_week', 'last_7_days']).optional(), day: z4.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }) },
    } as Record<string, { inputSchema: never }>
    expect(Object.keys(tools)).toContain('getInsights')
    for (const [name, t] of Object.entries(tools)) {
      const r = parseLikeAppleBridge(toJsonSchemaObject(t.inputSchema))
      expect(r.error, name).toBeNull()
    }
  })

  it('the framework\'s test tools lose nothing on the way', () => {
    expect(parseLikeAppleBridge(toJsonSchemaObject(SeriesInput)).lost).toEqual([])
    expect(lintToolInputSchema(toJsonSchemaObject(SeriesInput)).filter(i => i.level === 'error')).toEqual([])
  })

  it('getInsights (a compatibility tool) loses its minimum on device: known, and the framework re-checks it', () => {
    const insights = Object.assign({}, ...packExtensions<Record<string, { inputSchema: never }>>('tools')).getInsights
    expect(parseLikeAppleBridge(toJsonSchemaObject(insights.inputSchema)).lost).toEqual(['days.minimum'])
  })
})
