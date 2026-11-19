# @mongrov/analytics/tools

The AI tool framework over the analytics warehouse. It ships one tool of its
own — `getInsights`, over the platform `insight` table — and wraps every tool
the registered packs declare (`pack.tools`, `PackTool`).

Every tool runs through the same chain: **rate limit → authorize → execute →
output budget → audit**. Every call — success, rejected, rate-limited,
errored — is recorded in the `tool_call_audit` table.

The MCP subpath lives at `./mcp/` — see [`./mcp/README.md`](./mcp/README.md).

## Install

```bash
pnpm add @mongrov/analytics ai
```

`ai@>=4` is a peer dependency — the factory returns AI SDK `tool()` handles.

## Quick start

```ts
import { createAnalytics, registerPack } from '@mongrov/analytics'
import { createAnalyticsTools } from '@mongrov/analytics/tools'
import { streamText } from 'ai'

registerPack(weatherPack) // its `tools` join the map below

const toolsHandle = createAnalyticsTools({
  analytics, // an attached AnalyticsEngine
  familyMembersProvider: ({ familyId }) => api.listFamilyMemberIds(familyId),
  logger,
})

// Before every model turn, thread per-request identity into the handle.
toolsHandle.setContext({
  requesterUserId: 'user_1',
  brand: 'acme',
  familyId: 'fam_1',
  timezone: 'Europe/Berlin',
})

const result = await streamText({
  model,
  prompt: 'Was it windy this week?',
  tools: toolsHandle.tools,
})
```

On sign-out, `await toolsHandle.close()` flushes the audit writer.

## Tools

`toolsHandle.tools` holds every registered pack's tools in pack order, then
the platform's:

| Tool | Args | Purpose |
|---|---|---|
| `getInsights` | `userId`, `days` (1..30, default 7), `severity?` | Recent rows from the `insight` table |
| *(each pack's)* | the pack's Zod `inputSchema` | the pack's `impl` |

A tool name may be declared by one pack only; a second declaration throws at
registration.

## Writing a pack tool

```ts
import type { PackTool } from '@mongrov/analytics'
import { formatBytes, localDay, tzParam } from '@mongrov/analytics/tools'
import { z } from 'zod'

export const dailyRain: PackTool = {
  description: 'Total rain per day for a user. Args: userId, days (1..30).',
  inputSchema: z.object({ userId: z.string(), days: z.number().int().min(1).max(30) }),
  async impl({ userId, days }, ctx) {
    const sql = `SELECT ${localDay()} AS day, sum(rain_mm) AS mm
                   FROM v_weather_reading
                  WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
                    AND ts > now() - INTERVAL (${days}) DAY
                  GROUP BY 1 ORDER BY 1`
    const rows = await ctx.analytics.execute<{ day: string, mm: number }>(sql, {
      userId, brand: ctx.brand, familyId: ctx.familyId, ...tzParam(ctx, sql),
    })
    const text = rows.map(r => `${r.day}: ${r.mm.toFixed(1)} mm`).join('\n') || 'No data.'
    return { text, rowCount: rows.length, bytes: formatBytes(text) }
  },
}
```

- Parameterise SQL with `$name` placeholders; take `brand` and `familyId`
  from `ctx`, never from the model.
- Return a bounded plain-text summary (`ToolResult`), not JSON.
- `toolRead(ctx, name, build, params)` reads through a pack's bounded
  quality macros, falling back to the views.
- `localDay()` / `tzParam()` bucket by the user's local day
  (`ToolContext.timezone`).

## Configuration

`createAnalyticsTools(config)`:

| Field | Type | Default | Notes |
|---|---|---|---|
| `analytics` | `AnalyticsEngine` | (required) | Attached engine. |
| `authorize` | `AuthorizeFn` | `familyScopeAuthorize(analytics, { familyMembersProvider })` | Called before every execute; `false` rejects. |
| `rateLimit` | `RateLimitConfig \| false` | `DEFAULT_RATE_LIMIT` (20 per tool per minute, 200 per tool per hour, 60 per user per minute) | `false` disables — tests only. |
| `audit.enabled` | `boolean` | `true` | `false` makes `record()` a no-op. |
| `audit.batchSize` | `number` | `10` | Flush when the buffer reaches this many entries. |
| `audit.flushIntervalMs` | `number` | `1000` | Flush timer cadence. |
| `outputBudget` | `Partial<OutputBudget>` | `DEFAULT_OUTPUT_BUDGET` | Text over `maxBytes` is truncated UTF-8-safely with `\n[truncated]`. |
| `logger` | `ToolsLogger` | — | Warn / error hook. |
| `familyMembersProvider` | `FamilyMembersProvider` | — | Membership for the default authorize hook; otherwise `analytics.getFamilyMembers()`. |
| `clock` | `() => number` | `Date.now` | Injectable for tests. |

### Authorization

- `familyScopeAuthorize(analytics, { familyMembersProvider? })` — the
  default. Grants access when `args.userId` is the requester or a member of
  the requester's family. Fails closed on any error.
- `orgScopeAuthorize(analytics, { familyMembersProvider? })` — the same over
  an org; `ctx.familyId` is the org id.

Or pass any `AuthorizeFn = (toolName, args, ctx) => Promise<boolean>`.

### Rate limiting

Three in-process token buckets per `(toolName, userId)`. A call is refused
without spending when any bucket is empty. Runs before authorize.

### Audit

Each wrapper outcome (`success`, `rate_limited`, `authorized_reject`,
`error`) writes one `tool_call_audit` row. Writes are batched, non-blocking
and retried; after repeated failures a batch is dropped rather than growing
without bound. Retention: 30 days.

### Output budget

`applyOutputBudget` cuts `result.text` at a UTF-8-safe byte boundary and
appends `\n[truncated]`.

## Wiring with `@mongrov/ai`

`AIConfig.tools` takes the map directly:

```tsx
<AIProvider config={{ model, logger, tools: toolsHandle.tools }}>
  {children}
</AIProvider>
```

Keep the handle stable for the session (create it once per engine) and call
`setContext(...)` whenever the signed-in identity changes.

## Exports

`createAnalyticsTools`, `AnalyticsToolsConfig`, `AnalyticsToolsHandle`,
`AnalyticsToolMap`; `makeTool`, `MakeToolConfig`; `familyScopeAuthorize`,
`orgScopeAuthorize`, `AuthorizeFn`, `AuthorizeConfig`; `createRateLimiter`,
`RateLimiter`, `RateLimitConfig`, `DEFAULT_RATE_LIMIT`; `createAuditWriter`,
`AuditWriter`, `AuditEntry`; `applyOutputBudget`, `OutputBudget`,
`DEFAULT_OUTPUT_BUDGET`; `ToolContext`, `ToolResult`, `ToolImpl`,
`ToolOutcome`, `ToolsLogger`; `getInsights`, `getInsightsInputSchema`,
`GetInsightsInput`; `toolRead`, `localDay`, `tzParam`; `formatBytes`,
`deltaPct`, `popStddev`.
