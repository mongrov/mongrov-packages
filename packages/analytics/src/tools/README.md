# @mongrov/analytics/tools

Typed AI SDK tools for the Mongrov analytics warehouse. Six read-only
tools that let an LLM answer natural questions ("How was my sleep last
week?", "Any anomalies in my HRV?") from the local per-family DuckDB
warehouse.

Every tool runs through the same chain: **rate limit → authorize →
execute → output budget → audit**. Every call — success, rejected,
rate-limited, errored — is persisted to the `tool_call_audit` table.

Status: shipped in `@mongrov/analytics@0.1.0-alpha.10`. MCP subpath
lives at `./mcp/` — see [`./mcp/README.md`](./mcp/README.md).

## Install

```bash
pnpm add @mongrov/analytics ai
```

`ai@>=4` is a peer dependency — the factory returns AI SDK v4
`tool()` handles. `zod` is a transitive peer via `ai`.

## Quick start

```ts
import { createAnalytics } from '@mongrov/analytics'
import { createAnalyticsTools } from '@mongrov/analytics/tools'
import { openai } from '@ai-sdk/openai'
import { streamText } from 'ai'

const analytics = createAnalytics(analyticsConfig)
await analytics.attach({ brand: 'ziva', tenantScope: 'family', tenantId: 'fam_1', userId: 'u_1' })

const toolsHandle = createAnalyticsTools({
  analytics,
  familyMembersProvider: async ({ familyId }) => api.listFamilyMemberIds(familyId),
  logger,
})

// Before every LLM turn, thread per-request identity into the handle.
toolsHandle.setContext({
  requesterUserId: 'u_1',
  brand: 'ziva',
  familyId: 'fam_1',
})

const result = await streamText({
  model: openai('gpt-4o-mini'),
  system: 'You are a health assistant. Use the analytics tools to answer.',
  prompt: 'How was my sleep last week?',
  tools: toolsHandle.tools,
})
```

On shutdown / sign-out, call `await toolsHandle.close()` to flush the
audit writer.

## Available tools

All tools accept an `input` object validated by a Zod schema and
return a bounded plain-text summary (never JSON — the LLM speaks
natural language back to the user). Each targets a `userId` that is
either the requester themselves or another member of the same family
(gated by the `authorize` hook).

| Tool | Args | Purpose |
|---|---|---|
| `getHRV` | `userId`, `days` (1..90) | Average HRV per day + window baseline + latest delta |
| `getSleepSummary` | `userId`, `days` (1..90) | Nightly total / deep / REM minutes + window mean |
| `getActivityTotal` | `userId`, `days` (1..30) | Daily steps + calories + distance rolled up |
| `compareTrend` | `userId`, `metric`, `currentWindowDays`, `priorWindowDays` | Two-window delta narrative for one of `hrv_ms`, `sleep_total_minutes`, `activity_steps` |
| `detectAnomaly` | `userId`, `metric`, `lookbackDays` (7..90), `stddevThreshold` (1..4, default 2) | Flag days > threshold σ from baseline |
| `getInsights` | `userId`, `days` (1..30, default 7), `severity?` | Recent rows from the `insight` table, optional severity filter |

Every tool is described to the LLM via the `DESCRIPTIONS` map in
`factory.ts:63`; those descriptions are what the model reasons over
when deciding to call. Update them there if the tool's semantics
change.

## Configuration

`createAnalyticsTools(config)` accepts:

| Field | Type | Default | Notes |
|---|---|---|---|
| `analytics` | `AnalyticsEngine` | (required) | Attached engine. Tools throw `not_ready` if the engine has never attached. |
| `authorize` | `AuthorizeFn` | `familyScopeAuthorize(analytics, { familyMembersProvider })` | Called before every execute. Return `false` to reject. |
| `rateLimit` | `RateLimitConfig \| false` | `DEFAULT_RATE_LIMIT` (20/tool/min, 200/tool/hr, 60/user/min) | `false` disables — tests only. |
| `audit.enabled` | `boolean` | `true` | `false` makes `record()` a no-op; no writes to `tool_call_audit`. |
| `audit.batchSize` | `number` | `10` | Flush when the buffer hits this many entries. |
| `audit.flushIntervalMs` | `number` | `1000` | Flush timer cadence; `unref()`'d so it never blocks exit. |
| `outputBudget` | `Partial<OutputBudget>` | `{ maxBytes: 4096, maxRows: 100 }` | Text over `maxBytes` is UTF-8-safely truncated with `\n[truncated]`. |
| `logger` | `ToolsLogger` | `undefined` | Warn/error hook. No debug logs on the hot path. |
| `familyMembersProvider` | `FamilyMembersProvider` | `undefined` | If supplied, the default authorize hook resolves membership via this provider instead of SQL against `family_member`. |
| `clock` | `() => number` | `Date.now` | Injectable for tests. |

### Authorization

Two hooks ship out of the box:

- `familyScopeAuthorize(analytics, { familyMembersProvider? })` — the
  default. Grants access when `args.userId` is the requester or a
  member of the requester's family. Fails closed on any error
  (provider throws, SQL throws, malformed args).
- `orgScopeAuthorize(analytics, { familyMembersProvider? })` — parity
  hook against `org_member`. `ctx.familyId` is treated as the org id
  until orgs land as a first-class scope in `ToolContext`.

Roll your own by passing any `AuthorizeFn = (toolName, args, ctx) =>
Promise<boolean>` — e.g., attribute-based rules over `ctx.brand`
plus `toolName`.

### Rate limiting

Three independent token buckets per `(toolName, userId)`. `check()`
returns `false` without spending if any bucket is empty (fail-fast; no
partial deducts). Buckets are in-process; a restart resets them —
persistence is intentionally out of scope for v0.1.0. Enforcement
runs **before** authorize so abusive callers can't burn SQL cycles.

### Audit

Every wrapper branch (`success`, `rate_limited`, `authorized_reject`,
`error`) writes exactly one `tool_call_audit` row:

```
ts, brand, family_id, requester_user_id, tool_name, args,
result_bytes, result_row_count, latency_ms, outcome, error_message
```

Writes are batched (default: 10 rows or 1 s), non-blocking, and
retry once on flush failure. After 5 consecutive failures the batch
is dropped rather than growing unbounded. Retention: 30 days
(handled by the core retention sweep).

### Output budget

`applyOutputBudget` slices `result.text` at a UTF-8-safe byte
boundary — a partial multibyte codepoint at the cut is dropped
rather than emitting replacement characters — and appends
`\n[truncated]`. Impls also cap rows at the SQL layer;
`budget.maxRows` is informational.

## Wiring with `@mongrov/ai`

`@mongrov/ai@0.3.0` added an optional `tools` field on `AIConfig`;
threading the tool map through is a one-liner:

```tsx
import { AIProvider } from '@mongrov/ai'

<AIProvider
  config={{
    model: openai('gpt-4o-mini'),
    logger,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    tools: toolsHandle.tools,
  }}
>
  {children}
</AIProvider>
```

The provider forwards `config.tools` to both `streamText` and
`generateText` inside `ai-client.ts`. The `ChatScreen` in
`@mongrov/ai/ui` needs no changes to enable tool calls.

### React app pattern

For a full working example see `zivaone_app`:

- `src/lib/analytics/tools-handle.tsx` — a small provider that owns
  the `AnalyticsToolsHandle`, keeps it stable via
  `useRef`+`useMemo`, and calls `setContext(...)` in a `useEffect`
  on session identity changes. Disposes via `handle.close()` on
  unmount.
- `src/lib/ai/bridge.tsx` — an `AIProviderBridge` that reads
  `useAIConfig()` (which internally reads `useAnalyticsToolsHandle()`)
  and mounts `AIProvider` with `config.tools` populated.
- The bridge nests **inside** `AnalyticsSuite` so the same engine
  instance backs both the app's analytics UI and the tools handle.

Provider ordering:

```tsx
<AnalyticsProvider engine={engine}>
  <AnalyticsToolsHandleProvider engine={engine}>
    <AIProviderBridge>
      {children}
    </AIProviderBridge>
  </AnalyticsToolsHandleProvider>
</AnalyticsProvider>
```

## Adding a new tool

1. **Impl** — add `src/tools/impls/<name>.ts` exporting:
   - a Zod `inputSchema`
   - the inferred `Input` type
   - an async `ToolImpl<Input>` returning `{ text, rowCount, bytes }`

   Use `formatBytes(text)` from `../formatters` for the `bytes`
   field. Always parameterise SQL with `$name` placeholders (never
   string-interpolate); pull `brand` + `familyId` off `ctx`, never
   trust the LLM to supply them.

2. **Test** — add `src/tools/__tests__/<name>.test.ts` covering
   empty-result, populated-result, and edge cases (bad input handled
   by Zod → tool never runs).

3. **Register** — in `factory.ts`:
   - import the impl + schema + input type
   - add a `DESCRIPTIONS.<name>` line (this is what the LLM sees)
   - extend `AnalyticsToolMap` with a `<name>: ReturnType<typeof makeTool<Input>>` field
   - add a `<name>: makeTool({ ...shared, name: '<name>', description: DESCRIPTIONS.<name>, inputSchema, impl })` entry

4. **Export** — re-export the impl + schema + input type from
   `src/tools/index.ts` so consumers can compose custom subsets.

5. **Verify** — `pnpm test` (impl + factory tests), `pnpm typecheck`,
   `pnpm build`.

The `getHRV` tool (`impls/hrv.ts` + `__tests__/hrv.test.ts`) is the
smallest reference — one query, one narrative — copy that shape for
new sensor-window tools.

## MCP dev server

The same six tools are reachable over Model Context Protocol via
the `./mcp/` subpath — stdio for Claude Desktop, HTTP (bearer-gated)
for MCP Inspector or curl. Every MCP call reuses the same
`AnalyticsToolsHandle`, so the rate → auth → execute → budget →
audit chain and `tool_call_audit` writes are identical to AI SDK
usage. The subpath is dev-guarded (`shouldStartMcpServer()` reads
`__DEV__` or `ENABLE_MCP_SERVER=1`) and lives behind
`sideEffects: false` so prod RN bundles drop the SDK entirely.

See [`./mcp/README.md`](./mcp/README.md) for wiring, Claude Desktop
config, curl round-trip, and design notes.

```ts
import { createAnalyticsTools } from '@mongrov/analytics/tools'
import {
  createMcpServer,
  createStdioTransport,
  shouldStartMcpServer,
} from '@mongrov/analytics/tools/mcp'

if (shouldStartMcpServer()) {
  const mcp = createMcpServer({ toolsHandle })
  await mcp.connect(createStdioTransport())
}
```

## Public exports

Everything below is stable across `0.1.0-alpha.*`:

```ts
import {
  // Factory
  createAnalyticsTools,
  type AnalyticsToolsConfig,
  type AnalyticsToolsHandle,
  type AnalyticsToolMap,

  // Wrapper (for custom tool authors)
  makeTool,
  type MakeToolConfig,

  // Chain building blocks
  familyScopeAuthorize,
  orgScopeAuthorize,
  type AuthorizeFn,
  type AuthorizeConfig,
  createRateLimiter,
  type RateLimiter,
  type RateLimitConfig,
  DEFAULT_RATE_LIMIT,
  createAuditWriter,
  type AuditWriter,
  type AuditEntry,
  applyOutputBudget,
  type OutputBudget,
  DEFAULT_OUTPUT_BUDGET,

  // Shared types
  type ToolContext,
  type ToolResult,
  type ToolImpl,
  type ToolOutcome,
  type ToolsLogger,

  // Impls + schemas (for standalone use)
  getHRV, getHRVInputSchema, type GetHRVInput,
  getSleepSummary, getSleepSummaryInputSchema, type GetSleepSummaryInput,
  getActivityTotal, getActivityTotalInputSchema, type GetActivityTotalInput,
  compareTrend, compareTrendInputSchema, type CompareTrendInput,
  detectAnomaly, detectAnomalyInputSchema, type DetectAnomalyInput,
  getInsights, getInsightsInputSchema, type GetInsightsInput,
} from '@mongrov/analytics/tools'
```
