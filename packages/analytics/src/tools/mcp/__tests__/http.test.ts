import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeEngine } from '../../__fakes__/engine'
import { createAnalyticsTools, type AnalyticsToolsHandle } from '../../factory'
import type { ToolContext } from '../../types'
import { createMcpServer, type McpServerHandle } from '../server'
import { createHttpTransport, type HttpTransportHandle } from '../transports/http'

const baseCtx: ToolContext = {
  requesterUserId: 'alice',
  brand: 'zivaone',
  familyId: 'fam-1',
}

interface Wired {
  handle: AnalyticsToolsHandle
  mcp: McpServerHandle
  http: HttpTransportHandle
  url: string
  dispose: () => Promise<void>
}

async function wire(config: { authToken?: string } = {}): Promise<Wired> {
  const engine = createFakeEngine()
  engine.queueRows('FROM hrv', [{ day: '2026-07-10', avg_hrv: 42.5 }])
  const handle = createAnalyticsTools({
    analytics: engine,
    rateLimit: false,
    audit: { enabled: false },
  })
  handle.setContext(baseCtx)
  const mcp = createMcpServer({ toolsHandle: handle })
  const http = await createHttpTransport({
    port: 0,
    authToken: config.authToken,
  })
  await mcp.connect(http.transport)
  return {
    handle,
    mcp,
    http,
    url: `http://127.0.0.1:${http.port}/mcp`,
    dispose: async () => {
      await http.close()
      await mcp.close()
      await handle.close()
    },
  }
}

/** MCP `initialize` JSON-RPC request as the first hop of any client. */
function initializePayload() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'http-test', version: '0.0.0' },
    },
  }
}

describe('createHttpTransport', () => {
  let wired: Wired

  afterEach(async () => {
    if (wired) await wired.dispose()
  })

  describe('no authToken (dev mode)', () => {
    beforeEach(async () => {
      wired = await wire()
    })

    it('accepts unauthenticated POSTs', async () => {
      const res = await fetch(wired.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify(initializePayload()),
      })
      expect(res.status).toBe(200)
      await res.body?.cancel()
    })
  })

  describe('with authToken', () => {
    beforeEach(async () => {
      wired = await wire({ authToken: 'sekret-123' })
    })

    it('returns 401 without an Authorization header', async () => {
      const res = await fetch(wired.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify(initializePayload()),
      })
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer')
      await res.text()
    })

    it('returns 401 with wrong bearer token', async () => {
      const res = await fetch(wired.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
          'authorization': 'Bearer wrong-token',
        },
        body: JSON.stringify(initializePayload()),
      })
      expect(res.status).toBe(401)
      await res.text()
    })

    it('returns 200 with correct bearer token', async () => {
      const res = await fetch(wired.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
          'authorization': 'Bearer sekret-123',
        },
        body: JSON.stringify(initializePayload()),
      })
      expect(res.status).toBe(200)
      await res.body?.cancel()
    })

    it('returns 404 on unknown path (even with correct bearer)', async () => {
      const badUrl = wired.url.replace('/mcp', '/nope')
      const res = await fetch(badUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer sekret-123',
        },
        body: JSON.stringify(initializePayload()),
      })
      expect(res.status).toBe(404)
      await res.text()
    })
  })
})
