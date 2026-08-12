/**
 * Every tool must expose a valid JSON Schema of `type: "object"`.
 *
 * The AI SDK's `tool({ parameters: zodSchema })` path converts with zod-3
 * internals. Given a zod-4 schema it emits `type: "None"`, and OpenAI rejects
 * the entire request:
 *
 *   Invalid schema for function 'getSpO2': schema must be a JSON Schema of
 *   'type: "object"', got 'type: "None"'.
 *
 * Tools are sent on every request, so one bad schema broke all chat — a plain
 * "hi" included. Nothing caught it: the tools were constructed fine, the
 * types checked, and the failure only appeared as a provider error at runtime.
 */

import { describe, expect, it } from 'vitest'

import { createAnalyticsTools } from '../index'

function handle() {
  return createAnalyticsTools({
    analytics: { execute: async () => [] } as never,
    audit: { record: () => {} } as never,
  } as never)
}

describe('tool parameter schemas', () => {
  const tools = Object.entries(handle().tools)

  it('registers tools', () => {
    expect(tools.length).toBeGreaterThan(0)
  })

  it.each(tools)('%s exposes an object JSON Schema', (_name, tool) => {
    const params = (tool as { parameters?: unknown }).parameters as {
      jsonSchema?: Record<string, unknown>
    }

    // Must be the SDK's Schema wrapper, not a raw Zod object — that is the
    // whole point of the fix.
    expect(params?.jsonSchema).toBeDefined()
    expect(params.jsonSchema!.type).toBe('object')

    // `type: "None"` is the exact failure signature; assert it explicitly so
    // a regression names itself.
    expect(params.jsonSchema!.type).not.toBe('None')
  })
})
