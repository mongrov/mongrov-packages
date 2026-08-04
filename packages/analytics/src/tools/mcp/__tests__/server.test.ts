import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createFakeEngine } from '../../__fakes__/engine'
import { createAnalyticsTools, type AnalyticsToolsHandle } from '../../factory'
import { McpDisabledError } from '../guard'
import type { ToolContext } from '../../types'
import { createMcpServer, type McpServerHandle } from '../server'

// `createMcpServer` enforces the principle-41 guard: dev build AND flag.
// Satisfy both for the suite; restore afterwards.
const originalDev = (globalThis as Record<string, unknown>).__DEV__
const originalFlag = process.env.ENABLE_MCP_SERVER

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).__DEV__ = true
  process.env.ENABLE_MCP_SERVER = '1'
})

afterAll(() => {
  if (originalDev === undefined) {
    delete (globalThis as Record<string, unknown>).__DEV__
  }
  else {
    ;(globalThis as Record<string, unknown>).__DEV__ = originalDev
  }
  if (originalFlag === undefined) delete process.env.ENABLE_MCP_SERVER
  else process.env.ENABLE_MCP_SERVER = originalFlag
})

const baseCtx: ToolContext = {
  requesterUserId: 'alice',
  brand: 'zivaone',
  familyId: 'fam-1',
}

interface Wired {
  engine: ReturnType<typeof createFakeEngine>
  handle: AnalyticsToolsHandle
  mcp: McpServerHandle
  client: Client
  dispose: () => Promise<void>
}

async function wire(): Promise<Wired> {
  const engine = createFakeEngine()
  const handle = createAnalyticsTools({
    analytics: engine,
    rateLimit: false,
    audit: { enabled: false },
  })
  handle.setContext(baseCtx)

  const mcp = createMcpServer({ toolsHandle: handle })

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    { capabilities: {} },
  )

  await Promise.all([
    mcp.connect(serverTransport),
    client.connect(clientTransport),
  ])

  return {
    engine,
    handle,
    mcp,
    client,
    dispose: async () => {
      await client.close()
      await mcp.close()
      await handle.close()
    },
  }
}

describe('createMcpServer', () => {
  let wired: Wired

  beforeEach(async () => {
    wired = await wire()
  })

  afterEach(async () => {
    await wired.dispose()
  })

  it('list_tools returns all seven analytics tools with JSON Schemas', async () => {
    const res = await wired.client.listTools()
    const names = res.tools.map(t => t.name).sort()
    expect(names).toEqual([
      'compareTrend',
      'detectAnomaly',
      'getActivityTotal',
      'getHRV',
      'getInsights',
      'getSleepSummary',
      'getSpO2',
    ])
    for (const t of res.tools) {
      expect(typeof t.description).toBe('string')
      expect(t.inputSchema).toBeTypeOf('object')
      expect(t.inputSchema.type).toBe('object')
    }
  })

  it('call_tool getHRV drives the wrapped execute + returns text content', async () => {
    wired.engine.queueRows('FROM hrv', [
      { day: '2026-07-10', avg_hrv: 42.5 },
      { day: '2026-07-11', avg_hrv: 44.0 },
    ])

    const res = await wired.client.callTool({
      name: 'getHRV',
      arguments: { userId: 'alice', days: 7 },
    })
    const content = res.content as { type: string, text: string }[]
    expect(content).toHaveLength(1)
    expect(content[0].type).toBe('text')
    expect(content[0].text).toContain('HRV')
    expect(res.isError).toBeFalsy()
  })

  it('call_tool with unknown name returns isError text result', async () => {
    const res = await wired.client.callTool({
      name: 'no-such-tool',
      arguments: {},
    })
    expect(res.isError).toBe(true)
    const content = res.content as { type: string, text: string }[]
    expect(content[0].text).toContain('Unknown tool')
  })

  it('call_tool without setContext surfaces the wrapper error string', async () => {
    // Clear the context set in `wire()`.
    wired.handle.setContext(null)
    const res = await wired.client.callTool({
      name: 'getHRV',
      arguments: { userId: 'alice', days: 7 },
    })
    const content = res.content as { type: string, text: string }[]
    expect(content[0].text).toContain('context not set')
    // Wrapper wrote a text result (not a JSON-RPC error) — isError falsy.
    expect(res.isError).toBeFalsy()
  })
})

describe('createMcpServer — production guard (principle 41)', () => {
  it('throws McpDisabledError in a prod-like env (no __DEV__, no flag)', () => {
    delete (globalThis as Record<string, unknown>).__DEV__
    delete process.env.ENABLE_MCP_SERVER
    try {
      const engine = createFakeEngine()
      const handle = createAnalyticsTools({
        analytics: engine,
        rateLimit: false,
        audit: { enabled: false },
      })
      expect(() => createMcpServer({ toolsHandle: handle }))
        .toThrow(McpDisabledError)
    }
    finally {
      // Restore the suite-level dev+flag state for subsequent tests.
      ;(globalThis as Record<string, unknown>).__DEV__ = true
      process.env.ENABLE_MCP_SERVER = '1'
    }
  })

  it('works with __DEV__ true AND ENABLE_MCP_SERVER=1 (suite state)', () => {
    const engine = createFakeEngine()
    const handle = createAnalyticsTools({
      analytics: engine,
      rateLimit: false,
      audit: { enabled: false },
    })
    expect(() => createMcpServer({ toolsHandle: handle })).not.toThrow()
  })
})
