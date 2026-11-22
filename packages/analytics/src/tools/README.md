# @mongrov/analytics/tools

The AI tool framework over the analytics warehouse. It ships one tool of its
own — `getInsights`, over the platform `insight` table — and wraps every tool
the registered packs declare (`pack.tools`, `PackTool`).

Every tool runs through the same chain: **input check → answer cap → rate
limit → authorize → execute → output check → copy guard → render → budget →
audit → onResult**, and the model gets one string. Every call — success,
refused arguments, capped, rejected, rate-limited, errored — is recorded in
the `tool_call_audit` table.

Since 0.62.0 a tool is declared with `defineTool`: input AND output Zod
schemas, and an impl that returns a typed `ToolOutcome` envelope instead of
prose. The framework validates it, renders it for the model (pluggable;
`key: value` lines by default), trims it to a character budget, audits a
digest and hands the structured value to the host (`onResult`). An impl that
returns `ToolResult` text keeps working unchanged (the compatibility path).

A host's own tool (one built from host code a pack cannot reach) goes
through the same chain with `handle.add(def)` (wrapped AND listed in
`handle.tools`, so MCP sees it) or `handle.wrap(name, def)` (wrapped only).
Both share the handle's rate limiter, answer cap, audit writer and context.

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

## Writing a structured tool (0.62.0)

```ts
import { defineTool, outcome } from '@mongrov/analytics/tools'
import { z } from 'zod'

export const getRain = defineTool({
  name: 'getRain',
  description: 'Rain per day over a period, with the total.',
  inputSchema: z.object({
    userId: z.string(),
    period: z.enum(['this_week', 'last_7_days', 'last_30_days']).optional(),
  }),
  outputSchema: z.object({
    totalMm: z.number().nullable(),
    days: z.array(z.object({ date: z.string(), mm: z.number().nullable() })).max(31), // newest first
  }),
  budget: { listPaths: ['days'] }, // the framework may drop the oldest days
  async impl({ userId, period = 'this_week' }, ctx) {
    const rows = await readRain(ctx, userId, period)
    const window = { from: rows.from, to: rows.to, timezone: ctx.timezone ?? 'UTC', partialToday: true, label: period }
    if (rows.days.length === 0)
      return outcome.empty({ window, asOf: null })
    return outcome.ok({ totalMm: rows.total, days: rows.days }, { window, asOf: rows.newestAt })
  },
})
```

- **The envelope** (`ToolOutcome<D>`): `status` (`ok` / `empty` /
  `insufficient` / `error`), `data` (validated against `outputSchema`),
  `window` (`from`, `to`, `timezone`, `partialToday`, `label?`), `asOf`,
  `error` (`code`, `message`, `retryable`), `truncated` (set by the
  framework only) and `guidance` (≤ 3 lines of ≤ 140 chars, for the model,
  never for a UI). Build it with `outcome.ok / empty / insufficient /
  invalid`; an impl's only error is `outcome.invalid(message)` (its own
  argument refusal) — for anything else it throws, and the call is
  `internal`.
- **Output check.** A result that breaks the envelope rules or its
  `outputSchema` becomes `error/output_invalid` with guidance "Say the data
  could not be read right now; do not give any value". The audit lists the
  failing paths, never values. Under a test runner (vitest / jest) the call
  throws `ToolOutputError` instead, so a bad fixture fails its test
  (`outputValidation: 'throw' | 'error_outcome'` overrides).
- **Copy guard** runs over every string in the result (data leaves,
  guidance, the error message) and then over the rendered text.
- **Rendering** (`renderers.lines` default; `renderers.json`;
  `renderers.sentence(template)`). Precedence: `config.render.byTool[name]`
  → the definition's `render` → `config.render.default` → `lines`.
  `lines` prints `status`, `window`, `as_of` and `note:` lines first (a cut
  can never remove them), then data in schema key order: scalars as
  `key: value` (`null` = not measured), nested objects as `key: k=v, k=v`,
  lists of objects as one header line plus one line per item.
- **Budget**: `maxChars` (default 1,200 per result; a tool's
  `budget.maxChars` wins) and `turnChars` (default 3,600 per answer, floor
  300 for a late call). The framework drops whole items from the longest
  declared `budget.listPaths` list, oldest first, sets `truncated`, and as
  a last resort cuts at a line break (`truncated: cut`).
- **Input lint.** `defineTool` runs `lintToolInputSchema` in dev and test
  and throws on an error: the on-device JSON Schema subset (a flat object;
  no nullable fields or type lists, no `$ref`/`oneOf`, no `multipleOf`, no
  numeric range — the on-device bridge keeps only the maximum — string-only
  unions, portable regex patterns). `parseLikeAppleBridge` replicates the
  `@react-native-ai/apple` 0.12 schema parser for tests.

## Writing a compatibility (`ToolResult`) tool

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
- Return a bounded plain-text summary (`ToolResult`), not JSON. New tools
  should use `defineTool` and the envelope instead; `ToolResult` is kept for
  the packs that have not moved yet.
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
| `outputBudget` | `Partial<OutputBudget & { maxChars, turnChars }>` | `DEFAULT_OUTPUT_BUDGET`, `maxChars: 1200`, `turnChars: 3600` | `maxBytes`: `ToolResult` text loses its oldest dated rows first (see Output budget). `maxChars` / `turnChars`: structured results, per result / per answer. |
| `callLimit` | `{ perTurn, dedupe? } \| false` | `{ perTurn: 4, dedupe: true }` | Per answer (`beginTurn`). |
| `render` | `{ default?, byTool? }` | `renderers.lines` | Renderer choice for structured tools. |
| `outputValidation` | `'throw' \| 'error_outcome'` | `'throw'` under a test runner, else `'error_outcome'` | |
| `onResult` | `(event: ToolResultEvent) => void` | — | Also `handle.onResult(listener)`. |
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

### Answers: the call cap and the cache

```ts
const turn = toolsHandle.beginTurn()   // at the top of one model answer
try { /* generate */ } finally { turn.end() }   // { calls, refused, chars }
```

Inside an answer the framework counts calls: the 5th (`callLimit.perTurn`,
default 4) is refused `call_limit` with "No more tool calls for this
question. Answer now with what you already have." (a compatibility tool gets
exactly that text), audited and delivered to `onResult`. Calls with refused
arguments count too, so a model cannot loop on them. A repeat of the same
tool with the same validated arguments is answered from the answer's cache,
audited `cached = true`, and not counted. No answer open (MCP, tests): no cap
and no cache, only the rate limit. MCP calls never join an open answer.

### `onResult`

Every call, refusals included, ends with one `ToolResultEvent` after its
audit record: `toolName`, `source` (`ai` / `mcp`), `turnId`, `callIndex`,
`args`, a deep-frozen `outcome`, `rendered` (exactly what the model got),
`legacy`, `cached`, `latencyMs`, `auditOutcome`. A listener that throws is
logged and never changes the result.

### Argument validation

Every call's arguments are parsed with the tool's Zod schema before anything
else runs: `.default()`s apply and every bound is enforced, whatever the
caller checked (the AI SDK's `jsonSchema()` validates nothing, and on-device
bridges may drop bounds). A refused call returns
`Invalid arguments: days must be a whole number from 1 to 90 (got 0).` and is
audited as `invalid_args` (before 0.62.0: `error` with an `invalid_args:`
message prefix). The JSON Schema handed to
the model is the input view, so a field with a default is optional.

### Copy guard

Every registered pack's `copyGuard` runs over every tool's text, a pack's or
one wrapped with `handle.wrap` / `handle.add` — for a structured tool over
every string in the result and then the rendered text. A guard that throws
fails the call (`copy_guard`); the model never sees the offending text.

### Rate limiting

Three in-process token buckets per `(toolName, userId)`. A call is refused
without spending when any bucket is empty. Runs before authorize.

### Audit

Each call writes one `tool_call_audit` row, with `outcome` (`AuditOutcome`:
`success`, `invalid_args`, `call_limit`, `rate_limited`, `authorized_reject`,
`error`) and, since platform migration 3 (0.62.0), `result_status`,
`error_code`, `result_digest` (16-hex FNV-1a-64 of the text the model got —
no result content is stored), `render_chars`, `truncated_items`, `turn_id`,
`call_index` and `cached`. Writes are batched, non-blocking and retried;
after repeated failures a batch is dropped rather than growing without
bound. Retention: 30 days. The table never leaves the device.

### Output budget

`applyOutputBudget` drops dated rows (`  2026-11-20: ...`), oldest first by
date, until the text fits, and puts one `[truncated: N earlier rows left
out]` line where they were; header and summary lines are always kept. Only
text that has no dated rows, or does not fit even without them, is cut at a
UTF-8-safe byte boundary with `\n[truncated]`. `trimOldestRows` is the same
rule for a host's own cap.

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
`AnalyticsToolMap`, `DEFAULT_CALL_LIMIT`; `defineTool`, `ToolDefinition`,
`ToolExecContext`, `ToolAnnotations`, `lintToolDefinition`; `outcome`,
`ToolOutcome`, `ToolStatus`, `ToolErrorCode`, `ToolWindow`, `ToolError`,
`ToolTruncation`, `OutcomeMeta`, `isToolOutcome`, `toolOutcomeJsonSchema`;
`renderers`, `ToolRenderer`, `RenderContext`, `ToolRenderConfig`;
`ToolBudget`, `DEFAULT_MAX_CHARS`, `DEFAULT_TURN_CHARS`; `ToolResultEvent`,
`ToolTurn`, `TurnSummary`; `lintToolInputSchema`, `parseLikeAppleBridge`,
`LintIssue`; `ToolOutputError`, `CALL_LIMIT_GUIDANCE`,
`UNREADABLE_GUIDANCE`; `AuditOutcome`, `ToolCallResult`; `fnv1a64`;
`toJsonSchemaObject`, `toOutputJsonSchema`; `makeTool`, `MakeToolConfig`; `familyScopeAuthorize`,
`orgScopeAuthorize`, `AuthorizeFn`, `AuthorizeConfig`; `createRateLimiter`,
`RateLimiter`, `RateLimitConfig`, `DEFAULT_RATE_LIMIT`; `createAuditWriter`,
`AuditWriter`, `AuditEntry`; `applyOutputBudget`, `OutputBudget`,
`DEFAULT_OUTPUT_BUDGET`; `ToolContext`, `ToolResult`, `ToolImpl`,
`ToolsLogger`; `getInsights`, `getInsightsInputSchema`,
`GetInsightsInput`; `toolRead`, `localDay`, `tzParam`; `formatBytes`,
`deltaPct`, `popStddev`.
