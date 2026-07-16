# @mongrov/analytics/tools/mcp

Model Context Protocol server that exposes the six analytics tools
(`getHRV`, `getSleepSummary`, `getActivityTotal`, `compareTrend`,
`detectAnomaly`, `getInsights`) to any MCP client — Claude Desktop,
MCP Inspector, an internal Node CLI — over stdio or HTTP.

The server wraps the same `AnalyticsToolsHandle` used by the AI SDK
integration, so every MCP call runs the identical
**rate → auth → execute → budget → audit** chain and writes the
same `tool_call_audit` rows. There is no parallel wrapper.

Status: shipped in `@mongrov/analytics@0.1.0-alpha.10` under the
`./tools/mcp` subpath. Intended as a **dev-time** surface — the
guard + `sideEffects: false` make sure prod React Native bundles
strip it out.

## Install

```bash
pnpm add @mongrov/analytics @modelcontextprotocol/sdk
```

`@modelcontextprotocol/sdk` is declared as an **optional peer** so
apps that never enable MCP don't pay the install cost.
`zod-to-json-schema` is a hard dep of `@mongrov/analytics` and needs
no extra install step.

## Quick start (Node stdio — Claude Desktop)

Write a tiny entry (`bin/mcp-server.mjs`) that boots analytics + the
MCP server:

```js
import { createAnalytics } from '@mongrov/analytics'
import { createAnalyticsTools } from '@mongrov/analytics/tools'
import {
  createMcpServer,
  createStdioTransport,
  shouldStartMcpServer,
} from '@mongrov/analytics/tools/mcp'

if (!shouldStartMcpServer()) {
  // Wired for RN dev builds + Node `ENABLE_MCP_SERVER=1`. Refuse
  // to boot without one of those signals.
  process.exit(0)
}

const analytics = createAnalytics(analyticsConfig)
await analytics.attach({
  brand: 'ziva',
  tenantScope: 'family',
  tenantId: 'fam_1',
  userId: 'u_1',
})

const toolsHandle = createAnalyticsTools({
  analytics,
  familyMembersProvider,
})
toolsHandle.setContext({
  requesterUserId: 'u_1',
  brand: 'ziva',
  familyId: 'fam_1',
})

const mcp = createMcpServer({ toolsHandle })
await mcp.connect(createStdioTransport())
```

Add it to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mongrov-analytics": {
      "command": "node",
      "args": ["/absolute/path/to/bin/mcp-server.mjs"],
      "env": { "ENABLE_MCP_SERVER": "1" }
    }
  }
}
```

Restart Claude Desktop — the six tools appear under the tools icon.

## Quick start (Node HTTP — Inspector / curl)

```js
import {
  createMcpServer,
  createHttpTransport,
} from '@mongrov/analytics/tools/mcp'

const http = await createHttpTransport({
  port: 8787,
  path: '/mcp',
  authToken: process.env.MCP_BEARER, // required for any non-local use
})
const mcp = createMcpServer({ toolsHandle })
await mcp.connect(http.transport)
console.log(`MCP listening on http://127.0.0.1:${http.port}/mcp`)
```

`curl` round-trip:

```bash
curl -sS -X POST http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $MCP_BEARER" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Without `authToken` set, the transport accepts every request (dev
convenience) and logs a `warn` at boot. **Never** expose an
unauthenticated transport to an untrusted network.

## Reference

### `createMcpServer(config): McpServerHandle`

| Field | Type | Default | Notes |
|---|---|---|---|
| `toolsHandle` | `AnalyticsToolsHandle` | (required) | Handle from `createAnalyticsTools(...)`. |
| `name` | `string` | `'mongrov-analytics'` | Server name advertised on `initialize`. |
| `version` | `string` | `'0.1.0'` | Server version advertised on `initialize`. |
| `logger` | `ToolsLogger` | `undefined` | Warn/error sink. Errors thrown by tool handlers are logged here before being converted to `isError` text responses. |

Returns `{ server, connect(transport), close() }`. `close()` closes
the MCP session but does **not** close the underlying tools handle
— call `toolsHandle.close()` separately on shutdown.

### `createStdioTransport(opts?): Transport`

Node-only. Optional `stdin` / `stdout` streams for tests; defaults
to `process.stdin` / `process.stdout`.

### `createHttpTransport(config): Promise<HttpTransportHandle>`

| Field | Type | Default | Notes |
|---|---|---|---|
| `port` | `number` | `0` | `0` picks an ephemeral port (tests). |
| `path` | `string` | `'/mcp'` | Only this path is dispatched; everything else returns 404. |
| `authToken` | `string?` | `undefined` | Bearer token. Missing → all requests pass (dev). Wrong → 401 with `WWW-Authenticate: Bearer`. Compared with `crypto.timingSafeEqual`. |
| `logger` | `ToolsLogger?` | `undefined` | Boot warn if `authToken` unset; error on request-handler throws. |

Returns `{ transport, server, port, close() }`. `close()` shuts down
both the Node HTTP server and the underlying MCP transport.

### `shouldStartMcpServer(): boolean`

Cross-runtime dev flag. `true` iff:

- `__DEV__ === true` (React Native dev build), **or**
- `process.env.ENABLE_MCP_SERVER === '1'` (Node).

Consumers call this before `createMcpServer(...)`. The helper is
intentionally pure — importing it does not import the SDK.

### `toMcpTools(handle): McpTool[]`

Lower-level adapter used internally by `createMcpServer`. Converts
each wrapped AI SDK tool into
`{ name, description, inputSchema (JSON Schema draft-7), handler }`.
`.default()` values on Zod fields survive the conversion. Exposed
for callers wiring a custom MCP server layout.

## Design notes

- **Reuse over rebuild.** The MCP handler calls
  `tool.execute(args, { toolCallId, messages: [] })` on the AI SDK
  v4 tool the factory already built. Rate limiter buckets and audit
  writer batches are shared with any concurrent AI SDK usage —
  which is what you want if the analytics engine is also feeding
  `@mongrov/ai`.
- **Stateless HTTP.** The `StreamableHTTPServerTransport` is booted
  with `sessionIdGenerator: undefined`. Per-user scope rides on
  `toolsHandle.setContext(...)`, not the transport, so there's no
  MCP session state to persist. Each request is self-contained.
- **Fail-closed on unknown tools.** `call_tool` on a name we don't
  recognise returns `{ isError: true, content: 'Unknown tool: …' }`
  rather than raising a JSON-RPC error — LLMs handle text errors
  more gracefully than transport-level failures.
- **Tree-shake proof.** Nothing in this subpath is imported from
  `@mongrov/analytics/tools` or the root barrel. With
  `sideEffects: false` at the package root and the subpath separation
  in `exports`, a consumer that only imports `/tools` does not pull
  the SDK.

## Non-goals

- **Live HTTP server inside a running Expo dev build.** Deferred —
  would need `react-native-tcp-socket` transport plumbing. RN today
  gets the guard + adapter and the tree-shake path.
- **OAuth for MCP HTTP.** Bearer only. MCP is dev-only in v0.1.0;
  production auth would come with a hardening pass.
- **Resources, prompts, sampling.** Only `tools/*` methods are
  wired. Everything else on the MCP wire returns capability-not-set.
- **Published CLI (`mongrov-analytics-mcp`).** Users wire their own
  Node entry (see the Quick start above); the package intentionally
  does not ship a bin.
