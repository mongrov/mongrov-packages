/**
 * `createHttpTransport` — Node HTTP transport for `createMcpServer`.
 *
 * Boots a bare `node:http` server that gates requests behind an
 * optional bearer token, then hands them to the SDK's
 * `StreamableHTTPServerTransport`. Runs in stateless mode
 * (no `sessionIdGenerator`) — every request is self-contained, which
 * matches how our tools are already wired (`handle.setContext(...)`
 * carries the per-user scope, not the transport).
 *
 * Deliberately minimal:
 *   - one path (default `/mcp`)
 *   - one method (POST + GET both dispatched to the SDK)
 *   - bearer via `Authorization: Bearer <token>`, constant-time cmp
 *   - unauthenticated boot logs a warn but is allowed for local dev
 *
 * Meaningful only under Node; RN builds should never import this
 * module — the guard + `sideEffects: false` keep it out of prod
 * bundles.
 *
 * Callers wire it as:
 *   const t = await createHttpTransport({ port: 8787, authToken: 'x' })
 *   await mcpServer.connect(t.transport)
 *   // ...
 *   await t.close()
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ToolsLogger } from '../../types'
import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { assertMcpAllowed } from '../guard'

export interface CreateHttpTransportConfig {
  /** Listening port. `0` picks an ephemeral port (tests). Default `0`. */
  port?: number
  /** URL path. Default `/mcp`. */
  path?: string
  /**
   * Optional bearer token. If set, incoming requests must present
   * `Authorization: Bearer <authToken>` or get a 401. If unset, all
   * requests pass — logged as a warn on boot.
   */
  authToken?: string
  logger?: ToolsLogger
}

export interface HttpTransportHandle {
  /** The SDK transport — hand to `mcpServer.connect(...)`. */
  transport: Transport
  /** The Node HTTP server — exposed for advanced callers. */
  server: HttpServer
  /** Actual listening port (resolved when `port: 0`). */
  port: number
  /** Shut down the HTTP server + transport. */
  close: () => Promise<void>
}

const UNAUTHORIZED_BODY = 'Unauthorized\n'
const NOT_FOUND_BODY = 'Not Found\n'

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header || !header.startsWith('Bearer '))
    return false
  const presented = header.slice('Bearer '.length)
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length)
    return false
  return timingSafeEqual(a, b)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (chunks.length === 0)
        return resolve(undefined)
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : undefined)
      }
      catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
    req.on('error', reject)
  })
}

export async function createHttpTransport(
  config: CreateHttpTransportConfig = {},
): Promise<HttpTransportHandle> {
  // Principle 41: this entry binds a listening socket, so it enforces the
  // dev-only guard itself — not only via `createMcpServer`.
  assertMcpAllowed()

  const port = config.port ?? 0
  const path = config.path ?? '/mcp'
  const authToken = config.authToken

  if (!authToken) {
    config.logger?.warn(
      'MCP HTTP transport started without authToken — do not expose to untrusted networks',
    )
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  })

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Path check — only the configured path is dispatched.
    const url = req.url ?? ''
    const [reqPath] = url.split('?')
    if (reqPath !== path) {
      res.statusCode = 404
      res.setHeader('content-type', 'text/plain')
      res.end(NOT_FOUND_BODY)
      return
    }

    // Bearer check.
    if (authToken) {
      const header = req.headers.authorization
      if (!bearerMatches(header, authToken)) {
        res.statusCode = 401
        res.setHeader('content-type', 'text/plain')
        res.setHeader('www-authenticate', 'Bearer')
        res.end(UNAUTHORIZED_BODY)
        return
      }
    }

    // Body parse (POST) then dispatch.
    void (async () => {
      try {
        const body = req.method === 'POST' ? await readBody(req) : undefined
        await transport.handleRequest(req, res, body)
      }
      catch (err) {
        config.logger?.error('MCP HTTP transport request handler threw', {
          err: err instanceof Error ? err.message : String(err),
        })
        if (!res.headersSent) {
          res.statusCode = 500
          res.setHeader('content-type', 'text/plain')
          res.end('Internal Server Error\n')
        }
        else {
          res.end()
        }
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo | null
  const resolvedPort = address?.port ?? port

  return {
    transport,
    server,
    port: resolvedPort,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      await transport.close()
    },
  }
}
