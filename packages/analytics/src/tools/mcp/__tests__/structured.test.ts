/**
 * MCP mapping of structured tools (0.62.0): `outputSchema` (the envelope,
 * `data` typed from the tool's schema), `structuredContent`, a JSON text
 * copy (or the model's render), `isError` from the status, annotations, and
 * host tools added with `handle.add` listed. The SDK client validates every
 * `structuredContent` against the listed `outputSchema`, so each call here
 * is also a conformance check. zod 3 and zod 4 output schemas both.
 */

import type { PackTool } from '../../../core/packs'
import type { AnalyticsToolsHandle } from '../../factory'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as zod4 from 'zod/v4'
import { resetPacks } from '../../../core/packs'
import { okOutcome, seriesTool, setup } from '../../__tests__/support/structured'
import { outcome } from '../../outcome'
import { createMcpServer } from '../server'

const originalDev = (globalThis as Record<string, unknown>).__DEV__
const originalFlag = process.env.ENABLE_MCP_SERVER

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).__DEV__ = true
  process.env.ENABLE_MCP_SERVER = '1'
  // The package's dev zod is 3.25; a zod 4 consumer's root has `toJSONSchema`.
  const root = createRequire(import.meta.url)('zod') as { toJSONSchema?: unknown }
  root.toJSONSchema ??= zod4.toJSONSchema
})

afterEach(() => resetPacks())

afterAll(() => {
  if (originalDev === undefined)
    delete (globalThis as Record<string, unknown>).__DEV__
  else (globalThis as Record<string, unknown>).__DEV__ = originalDev
  if (originalFlag === undefined)
    delete process.env.ENABLE_MCP_SERVER
  else process.env.ENABLE_MCP_SERVER = originalFlag
})

function textTool(): PackTool & { name: string } {
  return {
    name: 'getText',
    description: 'A text tool.',
    inputSchema: z.object({ userId: z.string() }),
    impl: async () => ({ text: 'Plain text.', rowCount: 1, bytes: 11 }),
  }
}

async function connect(handle: AnalyticsToolsHandle, text?: 'json' | 'render') {
  const mcp = createMcpServer({ toolsHandle: handle, text })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} })
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)])
  // The client validates structured results against the listed schemas.
  const listed = await client.listTools()
  return { client, listed, close: async () => { await client.close(); await mcp.close() } }
}

const Z4Output = zod4.z.object({
  label: zod4.z.string(),
  avgValue: zod4.z.number().nullable(),
  summary: zod4.z.object({ daysWithData: zod4.z.number().int(), daysExpected: zod4.z.number().int() }),
  items: zod4.z.array(zod4.z.object({ date: zod4.z.string(), weekday: zod4.z.string(), value: zod4.z.number().nullable(), note: zod4.z.string().nullable() })).max(31),
})

describe.each([
  ['zod 3', undefined],
  ['zod 4', Z4Output],
] as const)('MCP structured output (%s output schema)', (_zod, z4) => {
  function wired(result?: Parameters<typeof seriesTool>[0], text?: 'json' | 'render') {
    const { handle, audit, events } = setup({ outputValidation: 'error_outcome' })
    handle.add({ ...seriesTool(result), ...(z4 ? { outputSchema: z4 as never } : {}) })
    handle.add(textTool())
    return { handle, audit, events, text }
  }

  it('lists the envelope outputSchema, title and annotations; host tools from handle.add are listed', async () => {
    const { handle } = wired()
    const { listed, close } = await connect(handle)
    try {
      const series = listed.tools.find(t => t.name === 'getSeries')!
      expect(series.title).toBe('Series')
      expect(series.annotations).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: false })
      expect(series.outputSchema).toMatchObject({
        type: 'object',
        required: ['status', 'data', 'window', 'asOf', 'error', 'truncated', 'guidance'],
      })
      const data = (series.outputSchema!.properties as Record<string, { anyOf: Record<string, unknown>[] }>).data
      expect(data.anyOf[0]).toMatchObject({ type: 'object', properties: { label: { type: 'string' } } })
      expect(JSON.stringify(series.outputSchema)).not.toContain('$ref')
      const text = listed.tools.find(t => t.name === 'getText')!
      expect(text.outputSchema).toBeUndefined()
      expect(text.annotations).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: false })
    }
    finally {
      await close()
    }
  })

  it('ok: structuredContent is the envelope; the text copy is its JSON; source mcp in onResult', async () => {
    const { handle, events } = wired()
    const { client, close } = await connect(handle)
    try {
      const res = await client.callTool({ name: 'getSeries', arguments: { userId: 'alice' } })
      expect(res.isError).toBeUndefined()
      expect(res.structuredContent).toEqual(JSON.parse(JSON.stringify(okOutcome())))
      expect((res.content as { text: string }[])[0].text).toBe(JSON.stringify(res.structuredContent))
      expect(events[0]).toMatchObject({ source: 'mcp', turnId: null })
    }
    finally {
      await close()
    }
  })

  it('text: render sends the model\'s string instead', async () => {
    const { handle } = wired()
    const { client, close } = await connect(handle, 'render')
    try {
      const res = await client.callTool({ name: 'getSeries', arguments: { userId: 'alice' } })
      expect((res.content as { text: string }[])[0].text.startsWith('status: ok\n')).toBe(true)
      expect(res.structuredContent).toMatchObject({ status: 'ok' })
    }
    finally {
      await close()
    }
  })

  it.each([
    ['refused arguments', undefined, { userId: 'alice', period: 'never' }, 'invalid_args'],
    ['an impl refusal', () => outcome.invalid('period is out of reach'), { userId: 'alice' }, 'invalid_args'],
    ['a throwing impl', () => { throw new Error('boom') }, { userId: 'alice' }, 'internal'],
    ['invalid output', () => outcome.ok({ label: 1 }, { window: null, asOf: null }), { userId: 'alice' }, 'output_invalid'],
  ] as const)('%s: isError, with a conforming error envelope', async (_case, result, args, code) => {
    const { handle } = wired(result as never)
    const { client, close } = await connect(handle)
    try {
      const res = await client.callTool({ name: 'getSeries', arguments: args })
      expect(res.isError).toBe(true)
      expect(res.structuredContent).toMatchObject({ status: 'error', data: null, error: { code } })
    }
    finally {
      await close()
    }
  })

  it('empty is not an error', async () => {
    const { handle } = wired(() => outcome.empty({ window: null, asOf: null }))
    const { client, close } = await connect(handle)
    try {
      const res = await client.callTool({ name: 'getSeries', arguments: { userId: 'alice' } })
      expect(res.isError).toBeUndefined()
      expect(res.structuredContent).toMatchObject({ status: 'empty', data: null })
    }
    finally {
      await close()
    }
  })

  it('a compatibility tool: text only, isError as 0.61.1', async () => {
    const { handle } = wired()
    const { client, close } = await connect(handle)
    try {
      const ok = await client.callTool({ name: 'getText', arguments: { userId: 'alice' } })
      expect(ok).toEqual({ content: [{ type: 'text', text: 'Plain text.' }] })
      const bad = await client.callTool({ name: 'getText', arguments: {} })
      expect(bad.isError).toBe(true)
      expect(bad.structuredContent).toBeUndefined()
    }
    finally {
      await close()
    }
  })
})
