/**
 * Every call that did not succeed comes back with `isError: true`.
 *
 * The wrapper answers refusals and failures with text, never a throw, so
 * before 0.61.1 an MCP client saw a rate-limited, unauthorized or failed
 * call as an ordinary result. Only an unknown tool and a throwing handler
 * set the flag. The text is unchanged.
 */

import type { ToolContext } from '../../types'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createFakeEngine } from '../../__fakes__/engine'
import { createAnalyticsTools } from '../../factory'
import { createMcpServer } from '../server'

const originalDev = (globalThis as Record<string, unknown>).__DEV__
const originalFlag = process.env.ENABLE_MCP_SERVER
const ctx: ToolContext = { requesterUserId: 'alice', brand: 'acme', familyId: 'fam-1' }
const disposers: (() => Promise<void>)[] = []
beforeAll(() => {
  ;(globalThis as Record<string, unknown>).__DEV__ = true
  process.env.ENABLE_MCP_SERVER = '1'
})
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()!()
})
afterAll(() => {
  if (originalDev === undefined)
    delete (globalThis as Record<string, unknown>).__DEV__
  else (globalThis as Record<string, unknown>).__DEV__ = originalDev
  if (originalFlag === undefined)
    delete process.env.ENABLE_MCP_SERVER
  else process.env.ENABLE_MCP_SERVER = originalFlag
})

async function connect(perToolPerMinute = 20) {
  const engine = createFakeEngine()
  const handle = createAnalyticsTools({
    analytics: engine,
    rateLimit: { perToolPerMinute, perToolPerHour: 200, perUserPerMinute: 60 },
    familyMembersProvider: async () => ['alice'],
    audit: { enabled: false },
  })
  handle.setContext(ctx)
  const mcp = createMcpServer({ toolsHandle: handle })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} })
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)])
  disposers.push(async () => {
    await client.close()
    await mcp.close()
    await handle.close()
  })
  const call = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: 'getInsights', arguments: args })
    return { isError: res.isError, text: (res.content as { text: string }[])[0].text }
  }
  return { engine, handle, call }
}

describe('MCP isError', () => {
  it('is not set on success', async () => {
    const { call } = await connect()
    const res = await call({ userId: 'alice', days: 7 })
    expect(res).toEqual({ isError: undefined, text: 'No insights in the last 7 days.' })
  })

  it('is set for refused arguments, with the reason in the text', async () => {
    const { call } = await connect()
    expect(await call({ userId: 'alice', days: 0 })).toEqual({
      isError: true,
      text: 'Invalid arguments: days must be a whole number from 1 to 30 (got 0).',
    })
  })

  it('is set when rate limited', async () => {
    const { call } = await connect(1)
    await call({ userId: 'alice' })
    expect(await call({ userId: 'alice' })).toEqual({ isError: true, text: 'Rate limit exceeded. Try again shortly.' })
  })

  it('is set when not authorized', async () => {
    const { call } = await connect()
    expect(await call({ userId: 'mallory' })).toEqual({ isError: true, text: 'Not authorized to access that user\'s data.' })
  })

  it('is set when the tool fails', async () => {
    const { engine, call } = await connect()
    engine.setError(new Error('boom'))
    expect(await call({ userId: 'alice' })).toEqual({ isError: true, text: 'Tool call failed.' })
  })

  it('is set when no context is set', async () => {
    const { handle, call } = await connect()
    handle.setContext(null)
    expect((await call({ userId: 'alice' })).isError).toBe(true)
  })

  it('advertises the input schema: days is optional and carries its default', async () => {
    const { handle } = await connect()
    const { toMcpTools } = await import('../adapter')
    const t = toMcpTools(handle).find(x => x.name === 'getInsights')!
    expect(t.inputSchema.required).toEqual(['userId'])
    expect((t.inputSchema.properties as Record<string, { default?: unknown }>).days.default).toBe(7)
    expect(t.inputSchema.$schema).toBeUndefined()
  })
})
