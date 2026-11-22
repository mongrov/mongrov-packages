# Upgrading

Notes for releases before 0.60 ship in those versions' own
`UPGRADING.md` (and stay in the repository's git history).

## 0.62.0 → 0.62.1

Nothing to change for a correct caller. What a caller may notice:

- **A second identical call in one answer is refused.** Inside
  `beginTurn()`, the first repeat of a call (same tool, same validated
  arguments) still returns the cached result; the second and later return
  only `DUPLICATE_CALL_GUIDANCE` and count toward the cap. A host that
  re-issued an identical call on purpose within one answer should reuse the
  first result instead. Calls outside an answer (MCP, tests) are unchanged.
- **Audit rows:** refused repeats are `outcome = 'call_limit'` with
  `cached = true`; cap refusals keep `cached = false`. A query that counted
  `cached = true` as served-from-cache should also filter
  `outcome = 'success'`.

## 0.61.1 → 0.62.0

**Breaking (type only):** the audit union `ToolOutcome` is now
`AuditOutcome`. Rename any import:

```ts
// before
import type { ToolOutcome } from '@mongrov/analytics/tools'   // 'success' | 'rate_limited' | …
// after
import type { AuditOutcome } from '@mongrov/analytics/tools'  // + 'invalid_args' | 'call_limit'
```

`ToolOutcome` is now the result envelope, so code that kept the old import
fails to typecheck rather than silently changing meaning. `ToolCallResult`
still names the audit union.

**Database:** on the next attach, platform migration 3 runs
`ALTER TABLE tool_call_audit ADD COLUMN …` for eight nullable columns.
Existing rows are kept (the new columns are NULL); it is idempotent, and a
fresh install only probes. Hosts that verify DDL on their device engine
should run that check for this release (new `ALTER` and a wider audit
`INSERT`).

**Audit rows:** refused arguments are now `outcome = 'invalid_args'` (were
`error` with an `invalid_args:` message prefix; the prefix is gone). A
dashboard or query filtering on either needs both forms for rows written
before and after the upgrade.

Nothing else changes for a tool that returns `ToolResult`. To adopt the new
pieces:

- **One answer = one turn.** Around each model answer:

  ```ts
  const turn = toolsHandle.beginTurn()
  try { /* generate */ } finally { turn.end() }
  ```

  This moves a per-answer call cap into the framework (default 4; the 5th
  call gets `CALL_LIMIT_GUIDANCE`, the same sentence a host cap typically
  returned) and answers repeated identical calls from the answer's cache. A
  host that kept its own cap and result-length cap can drop both: structured
  results are capped at `outputBudget.maxChars` (1,200) and
  `outputBudget.turnChars` (3,600 per answer).
- **Host tools**: `handle.add(defineTool({ … }))` instead of `handle.wrap` to
  have MCP list them as well.
- **Structured tools**: declare `outputSchema`, return `outcome.ok(data,
  { window, asOf, guidance })`. In tests, a result that breaks its schema
  throws `ToolOutputError`; at runtime it becomes `error/output_invalid`.
- **Structured results for the host**: `toolsHandle.onResult(event => …)`.

## 0.61.0 → 0.61.1

Nothing to change for a correct caller. What a caller may notice:

- **Arguments are now validated.** A call whose arguments break the tool's
  schema no longer reaches the tool: it returns
  `Invalid arguments: <field> must be ... (got ...).` and an `error` audit row
  whose message starts `invalid_args:`. A caller that relied on an omitted
  defaulted field arriving as `undefined` now gets the default.
- **Defaulted fields are optional in the advertised schema** (`required` no
  longer lists them). A strict client that always sent them still works.
- **Copy guards run on every tool**, so a host tool wrapped with
  `handle.wrap` and every pack tool is checked even if its impl does not call
  the guard itself.
- **Truncation keeps the newest rows.** Text over the budget loses its
  oldest dated lines first; check any test that pinned the old `[truncated]`
  tail.
- **MCP sets `isError`** on refusals and failures; a client that treated
  every text result as data will now see them flagged.

To give a host tool the same safety layer:

```ts
const handle = createAnalyticsTools({ analytics })
const myTool = handle.wrap('getThingDay', {
  description: 'One day of a thing, as its screen shows it.',
  inputSchema: z.object({ userId: z.string(), day: z.string().optional() }),
  impl: async (input, ctx) => ({ text, rowCount: 1, bytes: text.length }),
})
```

## 0.60.x → 0.61.0

Additive; nothing to change. Two new exports:

- **`@mongrov/analytics/testing`** — the pure modules (pack registry, DDL
  helpers, platform tables, errors, …) a test double of this package needs.
  A jest mock that deep-imports `node_modules/@mongrov/analytics/dist/…`
  files can re-export the subpath instead:

  ```ts
  // __mocks__/@mongrov/analytics.ts
  export * from '@mongrov/analytics/testing'
  // …your stubs for createAnalytics, AnalyticsProvider, the hooks, createSyncManager
  ```

  The names match the root and `/sync` exports; `resetPacks()` (testing
  only) clears registered packs between tests. See the README, "Testing your
  app", for the full list.
- **`userSettingKey(userId, key)`** — build the `KVStore` key of a user
  setting a rule reads (`user_setting` targets, `phase_band` scales) instead
  of writing `` `analytics:${userId}:${key}` `` by hand.

## 0.60.0 → 0.60.1

No API or behaviour change for a correct setup. Two things now fail loudly
that used to pass silently:

- Two registered packs declaring the same ingest adapter, rule context or
  tool name throw `AnalyticsError('invalid_config')` at registration, as two
  packs declaring the same table already did. Before, the first adapter or
  context won and the last tool won, without a word.
- A post-flush job or after-push hook that throws is logged and skipped; the
  other jobs, and the rest of the flush, still run.

And one fix: an attach that failed after a domain pack migrated but before
the platform pack's own migrations committed (a first 0.60 attach of a
database older than the platform ledger) no longer skips the platform
migrations on the next attach — the platform's adopted starting version is
now persisted even when it is 0.

See the repository's `CHANGELOG.md` for the full list.

## 0.52.x → 0.60.0 — the engine is domain-free; a domain arrives as a pack

**Breaking for imports; no change in behaviour, schema or stored data.** The
domain tables, quality views, metrics, baselines, rule contexts and
catalogs, AI tools, the device-export mapper and the post-flush derivations
left the package. They now live in **your domain pack** (in the consuming
app's own workspace) and reach the engine through its plug-in points:

| Plug-in | Pack field | What the engine does with it |
|---|---|---|
| Tables | `tables` (`PackTable`: DDL, time column, sync, retention, identity, view) | creates, migrates, sweeps, unions (`v_<table>`), keys the flusher and fetcher |
| Migrations | `migrations`, `versionKey`, `adoptVersion` | runs them per pack, each with its own KV ledger |
| Quality views | `quality` (`QualityViewProvider`) | builds them on attach and `setQuality`, with the bounded macros and their fallbacks |
| Ingest | `ingest` (`IngestAdapter`), `tables[t].validate` | `sink.ingest(name, raw, ctx)`: map, validate, count drops, buffer |
| Post-flush jobs | `postFlush` (`PostFlushJob`) | runs them inside every batch, before `batch:complete` |
| Sync hooks | `sync.afterPush` | runs after each r2 push, with `pushRemote` |
| Baselines | `baselines` (`BaselineProvider`) | computes them each cycle into `user_baseline` |
| Metrics, rules | `metrics`, `rules` (`RulePack`) | rule schema, compiler, validator and evaluator read them |
| Tools | `tools` | `createAnalyticsTools` wraps them |
| Copy guard | `copyGuard` | carried on the pack for its tools' own use |

`definePack` checks a pack; `createAnalytics({ packs })` or `registerPack`
registers it. The platform pack (`insight`, `sync_watermark`,
`tool_call_audit`, `user_baseline`) is always present.

**The engine has no domain tables until packs are registered.** A bare
`createAnalytics(config)` creates only the platform tables. A rule or tool
that names a domain table or metric fails to parse until the pack declaring
it is registered — register packs before parsing rule catalogs (importing a
pack module that calls `registerPack` at load is one way).

**Existing databases.** Table and column names are unchanged. A domain pack
can keep the package's old migration ledger (`versionKey` naming the old
key), and the platform pack adopts its migrations from it (`adoptVersion`), so a
database migrated by 0.52 attaches with no DDL at all.

**What the app changes:**

- `createAnalytics({ ..., packs: [yourPack] })`, or `registerPack(yourPack)`
  before the first attach.
- The domain-specific exports (table name lists, local schemas, quality-view
  SQL, baseline SQL and definitions, rule catalogs, device-export mappers,
  domain tools and their copy guidelines, typed quality options, KV key
  helpers) are no longer exported from `@mongrov/analytics`,
  `@mongrov/analytics/sync`, `@mongrov/analytics/rules`,
  `@mongrov/analytics/tools` or `@mongrov/types`; import them from your
  domain pack.
- A device-specific `SensorSink` push method becomes
  `sink.ingest('<adapter name>', raw, ctx)` with the adapter your pack
  registers under `ingest`.
- `R2Pusher` keeps only the generic `pushRemote(table, ctx, run)`; a pack's
  `sync.afterPush` hook uses it for its own remote writes.
- `createSyncManager`: options for a pack's post-flush jobs move under
  `options` (e.g. `options: { <job option>: false }`).
- `AnalyticsConfig.quality` / `setQuality` take the packs' options
  (`object`); your pack types them.
- `Rule.metric` and `Rule.context` are `string`; they are checked when a rule
  is parsed, against the registered packs.

**Added, generic:** `definePack`, `registerPack(s)`, `getPacks`, `packTable(s)`,
`viewedTables`, `ingestAdapter`, `metricDefinition`, `exposedMetricIds`,
`readRelation` and friends, `ensureSchemas`, `listColumns`, `localDdlFor`,
`hasLocalPrimaryKey`, `addIdentityKey`, `quoteQualifier`, `toLocalDdl`,
`qualifyDdl`, `REMOTE_NAMESPACE`, `PLATFORM_*`, the bounded-read helpers
(`boundedRelation`, `executeBounded`, …), `HybridDuckDB`, `describeError`,
`tailId`, `createBaselineRunner`, `mergeFlushResults`, `validateRows`,
`DropTally`, `logError`, `minDayReadings`, `parseCatalog`, `contextJoin`,
`toolRead`, `localDay`, `tzParam`.

**Still exported:** `NotImplementedError` (an `AnalyticsError` with code
`not_implemented`). The package throws it in one place: opening an engine
created without a DuckDB factory (`createAnalytics(config, { duckdbFactory })`
supplies one).
