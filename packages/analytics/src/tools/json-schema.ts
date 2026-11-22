/**
 * Zod → JSON Schema, for both supported zod lines (`^3.23.8 || ^4.0.0`).
 *
 * The consumer's zod version is not ours to pick, and the AI SDK's own Zod
 * path emits `type: "None"` for a zod 4 schema (OpenAI then rejects the whole
 * request, so one bad schema breaks every chat). Converting here and handing
 * the SDK a finished JSON Schema removes that coupling.
 */

import type { ZodTypeAny } from 'zod'

type Json = Record<string, unknown>

interface Zod4Root {
  toJSONSchema: (s: unknown, params?: { io?: 'input' | 'output', unrepresentable?: 'throw' | 'any' }) => Json
}

function zod4(schema: ZodTypeAny): boolean {
  return (schema as unknown as { _zod?: unknown })._zod !== undefined
}

function zod4Root(): Zod4Root {
  // `require('zod')` only: a bundler resolves every literal require, and a
  // consumer on zod 3 has no zod 4 subpath to resolve.
  return require('zod') as Zod4Root
}

function zod3ToJsonSchema(schema: ZodTypeAny, options?: Json): Json {
  const { zodToJsonSchema } = require('zod-to-json-schema') as {
    zodToJsonSchema: (s: unknown, options?: Json) => Json
  }
  return zodToJsonSchema(schema, options)
}

/**
 * The INPUT view of a tool's argument schema (`io: 'input'`): a field with a
 * `.default()` is optional to the caller, because the framework applies the
 * default. zod 4's default (output) view lists it in `required`, which made
 * every strict caller, an on-device model among them, supply it.
 */
export function toJsonSchemaObject(schema: ZodTypeAny): Json {
  if (zod4(schema)) {
    const zod = zod4Root()
    const input = zod.toJSONSchema(schema, { io: 'input' })
    // The input view leaves out `additionalProperties: false`; keep the
    // object closed, as the output view (and every earlier release) had it.
    const closed = zod.toJSONSchema(schema).additionalProperties === false
    return closed ? { ...input, additionalProperties: false } : input
  }
  // zod-to-json-schema already treats a `.default()` field as optional.
  return zod3ToJsonSchema(schema)
}

/**
 * The OUTPUT view of a result schema (what a validated value looks like),
 * self-contained (no `$ref` into a parent document) so it can be embedded in
 * the envelope's schema. Definitions a cyclic schema needs come back under
 * `$defs`, for the caller to hoist to the root.
 */
export function toOutputJsonSchema(schema: ZodTypeAny): Json {
  let out: Json
  if (zod4(schema)) {
    out = zod4Root().toJSONSchema(schema, { io: 'output', unrepresentable: 'any' })
  }
  else {
    out = zod3ToJsonSchema(schema, { $refStrategy: 'none', effectStrategy: 'input' })
  }
  const { $schema: _drop, ...rest } = out
  return rest
}
