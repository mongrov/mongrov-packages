/**
 * `makeTool` parses every call's arguments with the tool's Zod schema.
 *
 * Before 0.61.1 nothing did: the AI SDK's `jsonSchema()` carries no
 * validator, the on-device bridge parses with none (and keeps only one
 * numeric bound), and MCP passes arguments straight through. So `.default()`
 * never applied, and `days: 0` reached the SQL and read as "no data".
 * Both zod lines are covered: the package supports `^3.23.8 || ^4.0.0`.
 */

import type { AuditEntry, AuditWriter, ToolContext, ToolImpl } from '../types'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { z as z3 } from 'zod'
import * as zod4 from 'zod/v4'
import { createFakeEngine } from '../__fakes__/engine'
import { makeTool, toJsonSchemaObject } from '../wrap'

const z4 = zod4.z

// The package's dev zod is 3.25, whose root has no `toJSONSchema`; a zod 4
// consumer's root has it, and that is where `makeTool` looks. Give the
// root module the zod 4 converter for the zod 4 cases, as a zod 4 install has.
beforeAll(() => {
  const root = createRequire(import.meta.url)('zod') as { toJSONSchema?: unknown }
  root.toJSONSchema ??= zod4.toJSONSchema
})

const ctx: ToolContext = { requesterUserId: 'alice', brand: 'acme', familyId: 'fam-1' }

function fakeAudit(): AuditWriter & { records: AuditEntry[] } {
  const records: AuditEntry[] = []
  return { records, record: e => records.push(e), flush: async () => {}, close: async () => {} }
}

const schemas = {
  'zod 3': z3.object({
    userId: z3.string(),
    days: z3.number().int().min(1).max(90).default(7),
    kind: z3.enum(['alpha', 'beta']).optional(),
    factor: z3.number().min(1).max(4).default(2),
  }),
  'zod 4': z4.object({
    userId: z4.string(),
    days: z4.number().int().min(1).max(90).default(7),
    kind: z4.enum(['alpha', 'beta']).optional(),
    factor: z4.number().min(1).max(4).default(2),
  }),
} as const

function build(schema: unknown) {
  const audit = fakeAudit()
  const seen: unknown[] = []
  const impl: ToolImpl<any> = async (input) => {
    seen.push(input)
    return { text: 'ok', rowCount: 1, bytes: 2 }
  }
  const limiterCalls: string[] = []
  const tool = makeTool<any>({
    name: 'getSeries',
    description: 'test',
    inputSchema: schema as never,
    impl,
    analytics: createFakeEngine(),
    audit,
    budget: { maxBytes: 4096, maxRows: 100 },
    rateLimiter: { check: (n) => { limiterCalls.push(n); return true } },
    ctxProvider: () => ctx,
  })
  const run = (args: unknown, options: object = {}) => tool.execute!(args as never, options as never)
  return { tool, audit, seen, run, limiterCalls }
}

describe.each(Object.entries(schemas))('makeTool argument validation (%s)', (_label, schema) => {
  it('applies .default() for a missing field and hands the parsed input to the impl', async () => {
    const t = build(schema)
    const out = await t.run({ userId: 'alice' })
    expect(out).toBe('ok')
    expect(t.seen).toEqual([{ userId: 'alice', days: 7, factor: 2 }])
    // The audit records what ran, defaults included.
    expect(t.audit.records[0].args).toEqual({ userId: 'alice', days: 7, factor: 2 })
    expect(t.audit.records[0].outcome).toBe('success')
  })

  it.each([
    ['zero', 0, 'days must be a whole number from 1 to 90 (got 0)'],
    ['negative', -3, 'days must be a whole number from 1 to 90 (got -3)'],
    ['over the maximum', 91, 'days must be a whole number from 1 to 90 (got 91)'],
    ['a fraction', 2.5, 'days must be a whole number from 1 to 90 (got 2.5)'],
    ['the wrong type', '7', 'days must be a whole number from 1 to 90 (got "7")'],
  ])('refuses days %s with a message naming the accepted range', async (_case, days, clause) => {
    const t = build(schema)
    const out = await t.run({ userId: 'alice', days })
    expect(out).toBe(`Invalid arguments: ${clause}.`)
    // The impl never ran, and the call is audited as refused arguments,
    // with the message that says why (0.62.0: its own outcome, no longer
    // `error` with an `invalid_args:` prefix).
    expect(t.seen).toEqual([])
    expect(t.audit.records).toHaveLength(1)
    expect(t.audit.records[0].outcome).toBe('invalid_args')
    expect(t.audit.records[0].errorCode).toBe('invalid_args')
    expect(t.audit.records[0].errorMessage).toBe(`Invalid arguments: ${clause}.`)
  })

  it('names a missing required field', async () => {
    const t = build(schema)
    expect(await t.run({ days: 3 })).toBe('Invalid arguments: userId is required and must be a string.')
  })

  it('lists the allowed values of an enum and reports every bad field', async () => {
    const t = build(schema)
    expect(await t.run({ userId: 'alice', kind: 'gamma', factor: 9 })).toBe(
      'Invalid arguments: kind must be one of "alpha", "beta" (got "gamma"); '
      + 'factor must be a number from 1 to 4 (got 9).',
    )
  })

  it('refuses arguments that are not an object', async () => {
    const t = build(schema)
    expect(await t.run('days=7')).toBe('Invalid arguments: send the arguments as an object.')
  })

  it('treats no arguments at all as an empty object', async () => {
    const t = build(schema)
    expect(await t.run(undefined)).toBe('Invalid arguments: userId is required and must be a string.')
  })

  it('validates before the rate limiter is charged', async () => {
    const t = build(schema)
    await t.run({ userId: 'alice', days: 0 })
    expect(t.limiterCalls).toEqual([])
    await t.run({ userId: 'alice', days: 1 })
    expect(t.limiterCalls).toEqual(['getSeries'])
  })

  it('emits the INPUT schema: a defaulted field is optional and keeps its default', () => {
    const json = toJsonSchemaObject(schema as never) as {
      required?: string[]
      properties: Record<string, Record<string, unknown>>
      additionalProperties?: unknown
    }
    expect(json.required).toEqual(['userId'])
    expect(json.properties.days).toMatchObject({ type: 'integer', minimum: 1, maximum: 90, default: 7 })
    expect(json.properties.factor).toMatchObject({ minimum: 1, maximum: 4, default: 2 })
    expect(json.additionalProperties).toBe(false)
  })

  it('hands the same schema to the AI SDK', () => {
    const t = build(schema)
    const params = (t.tool as { parameters?: { jsonSchema?: { required?: string[] } } }).parameters
    expect(params?.jsonSchema?.required).toEqual(['userId'])
  })
})
