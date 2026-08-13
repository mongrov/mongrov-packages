/**
 * `createStdioTransport` — Node stdio transport for `createMcpServer`.
 *
 * Reads MCP framed messages off `process.stdin` and writes them to
 * `process.stdout`. Meaningful only under Node; on Hermes there is no
 * stdio pipe. Callers should gate construction behind
 * `shouldStartMcpServer()` so this module is never imported in prod
 * RN builds (and its `node:stream` peer disappears with the rest of
 * the MCP subpath under `sideEffects: false`).
 *
 * The SDK's `StdioServerTransport` accepts optional `stdin` / `stdout`
 * streams; we expose the same knobs for tests that want to pipe
 * fixtures without touching real stdio.
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Readable, Writable } from 'node:stream'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

export interface CreateStdioTransportOptions {
  stdin?: Readable
  stdout?: Writable
}

export function createStdioTransport(
  options: CreateStdioTransportOptions = {},
): Transport {
  return new StdioServerTransport(options.stdin, options.stdout)
}
