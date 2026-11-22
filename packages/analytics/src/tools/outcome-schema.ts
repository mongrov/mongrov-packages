/**
 * The JSON Schema of a whole `ToolOutcome` envelope, with `data` typed from a
 * tool's `outputSchema` (its output view). MCP's `outputSchema` for a
 * structured tool: a client checks `structuredContent` against it.
 */

import type { ZodTypeAny } from 'zod'
import { toOutputJsonSchema } from './json-schema'
import { MAX_GUIDANCE_CHARS, MAX_GUIDANCE_ITEMS, MAX_WINDOW_LABEL_CHARS, TOOL_ERROR_CODES, TOOL_STATUSES } from './outcome'

type Json = Record<string, unknown>

const nullable = (schema: Json): Json => ({ anyOf: [schema, { type: 'null' }] })

const WINDOW: Json = {
  type: 'object',
  properties: {
    from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    timezone: { type: 'string' },
    partialToday: { type: 'boolean' },
    label: { type: 'string', maxLength: MAX_WINDOW_LABEL_CHARS },
  },
  required: ['from', 'to', 'timezone', 'partialToday'],
  additionalProperties: false,
}

const ERROR: Json = {
  type: 'object',
  properties: {
    code: { type: 'string', enum: [...TOOL_ERROR_CODES] },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
    fieldErrors: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: ['code', 'message', 'retryable'],
  additionalProperties: false,
}

const TRUNCATION: Json = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    droppedItems: { type: 'integer', minimum: 0 },
    kept: { type: 'string', enum: ['newest', 'oldest'] },
    hardCut: { type: 'boolean' },
  },
  required: ['path', 'droppedItems', 'kept', 'hardCut'],
  additionalProperties: false,
}

export function toolOutcomeJsonSchema(outputSchema: ZodTypeAny): Json {
  const { $defs, definitions, ...data } = toOutputJsonSchema(outputSchema)
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [...TOOL_STATUSES] },
      data: nullable(data),
      window: nullable(WINDOW),
      asOf: nullable({ type: 'string' }),
      error: nullable(ERROR),
      truncated: nullable(TRUNCATION),
      guidance: { type: 'array', items: { type: 'string', maxLength: MAX_GUIDANCE_CHARS }, maxItems: MAX_GUIDANCE_ITEMS },
    },
    required: ['status', 'data', 'window', 'asOf', 'error', 'truncated', 'guidance'],
    additionalProperties: false,
    // Definitions a cyclic data schema refers to (`#/$defs/...`) live at the root.
    ...($defs ? { $defs } : {}),
    ...(definitions ? { definitions } : {}),
  }
}
