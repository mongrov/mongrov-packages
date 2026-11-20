# @mongrov/analytics

DuckDB + R2 Iceberg local analytics for React Native / Expo apps.

Per-family (or per-tenant) warehouses attached as DuckDB catalogs, zero-copy
reads against R2 Iceberg tables (or a local-only mode), a write-side sync
pipeline, a structured threshold-rule engine and AI SDK tools with an MCP dev
server. Headless core with optional React hooks.

The engine is **domain-free**. It knows only its own platform tables; every
domain table, view, ingest adapter, rule context and tool arrives as a
**pack** you register (see [Packs](#packs)).

Status: **0.61.x**. Upgrade notes: [UPGRADING.md](./UPGRADING.md) (ships
with the package); changes: [CHANGELOG.md](https://github.com/mongrov/mongrov-packages/blob/master/packages/analytics/CHANGELOG.md) (in the
repository).

## Subpaths

| Import | What |
|---|---|
| `@mongrov/analytics` | engine, factory, packs, hooks, provider, errors |
| `@mongrov/analytics/sync` | sensor sink, ingest, buffer, flusher, R2 push/fetch, scheduler |
| `@mongrov/analytics/rules` | rule schema, validator, compiler, rules engine, hooks |
| `@mongrov/analytics/tools` | tool framework (authorize, rate limit, output budget, audit) |
| `@mongrov/analytics/tools/mcp` | Model Context Protocol dev server over the same tools |
| `@mongrov/analytics/testing` | the pure modules (pack registry, DDL helpers, platform tables, errors) for an app's test double of this package — see [Testing your app](#testing-your-app) |
| `@mongrov/analytics/ui` | reserved |

## Install

```bash
pnpm add @mongrov/analytics
# Peer deps
pnpm add react-native-duckdb @mongrov/db @mongrov/types
```

`react-native-duckdb` is an **optional peer**: importing `createAnalytics` on
a Node/CI host without the native module does not throw. Supply a DuckDB
factory as the second argument, `createAnalytics(config, { duckdbFactory })`;
opening an engine without one fails with `AnalyticsError('engine_open_failed')`.

## Quick start

```tsx
import type { AnalyticsConfig } from '@mongrov/analytics'
import { AnalyticsProvider, createAnalytics, useAnalytics } from '@mongrov/analytics'
import { useEffect } from 'react'
import { Text } from 'react-native'
import { weatherPack } from './weather-pack' // see "Packs" below

const config: AnalyticsConfig = {
  storage: kv, // @mongrov/db KVStore or any structural equivalent
  warehouseUriBuilder: (brand, scope, tenantId) =>
    `s3://analytics/${brand}/${tenantId}/warehouse`,
  catalogEndpoint: 'https://catalog.example.com',
  tokenVendor: {
    async fetch({ brand, tenantScope, tenantId }) {
      const res = await api.getWarehouseToken({ brand, tenantScope, tenantId })
      return {
        token: res.token,
        expiresAt: new Date(res.expiresAt),
        // What the token grants; the engine checks it against the attach.
        scopeClaims: { brand, tenantScope, tenantId, permissions: res.permissions },
      }
    },
  },
  familyMembersProvider: ({ brand, familyId }) => api.listFamilyMembers({ brand, familyId }),
  retention: { acme: { days: 180 } }, // keyed by brand
  packs: [weatherPack],
  logger: appLogger, // optional; defaults to a no-op
}

const engine = createAnalytics(config, { duckdbFactory })

function App() {
  return (
    <AnalyticsProvider engine={engine}>
      <Dashboard />
    </AnalyticsProvider>
  )
}

function Dashboard() {
  // State only: attach and detach are on the engine itself.
  const { state, isReady, isAttached } = useAnalytics()
  useEffect(() => {
    if (isReady && !isAttached)
      void engine.attach({ brand: 'acme', tenantScope: 'family', tenantId: 'fam_123', userId: 'user_1' })
  }, [isReady, isAttached])
  return <Text>State: {state}</Text>
}
```

For a device-only setup, `mode: 'local'` drops the R2 fields: no `iceberg` /
`httpfs` extensions, no remote catalog, push and fetch are no-ops, rules still
run on each batch.

## Packs

A pack is a plain object checked by `definePack` and registered with
`registerPack(pack)`, `registerPacks([...])` or `createAnalytics({ packs })`.
Register packs before the first attach and before parsing rules: until a pack
is registered, the engine has none of its tables, metrics or contexts.

| Plug-in | Pack field | What the engine does with it |
|---|---|---|
| Tables | `tables` (`PackTable`: DDL, time column, sync, retention, identity, view, validate) | creates, migrates, sweeps, unions (`v_<table>`), keys the flusher and fetcher |
| Migrations | `migrations`, `versionKey`, `legacyVersionKeys`, `adoptVersion` | runs them per pack, each with its own KV ledger |
| Quality views | `quality` (`QualityViewProvider`) | builds them on attach and `setQuality`, with bounded macros and fallbacks |
| Ingest | `ingest` (`IngestAdapter`), `tables[t].validate` | `sink.ingest(name, raw, ctx)`: map, validate, count drops, buffer |
| Post-flush jobs | `postFlush` (`PostFlushJob`) | runs them inside every batch, before `batch:complete` |
| Sync hooks | `sync.afterPush` (`PackSyncHooks`) | runs after each r2 push, with `pushRemote` |
| Baselines | `baselines` (`BaselineProvider`) | computes them per user and window into `user_baseline` |
| Metrics | `metrics` (`MetricDefinition`) | what rules, baselines and tools may name |
| Rules | `rules` (`RulePack`: contexts, windows, validate, admit, settings) | read by the rule schema, validator and compiler |
| Tools | `tools` (`PackTool`) | wrapped by `createAnalyticsTools` |
| Copy guard | `copyGuard` | carried on the pack for its own tools and formatters; the framework does not call it |

The **platform pack** is always registered after yours: the `insight`,
`sync_watermark`, `tool_call_audit` and `user_baseline` tables and the
`getInsights` tool. Pack order is registration order, then the platform; a
table, ingest adapter, rule context or tool name may be declared by one pack
only — a second declaration throws `AnalyticsError('invalid_config')` at
registration.

An app's own product tables can also be passed as `appSchema`
(`AppSchema`); they run through the same migration runner and retention
sweep, without a union view.

### Example: a weather pack

```ts
import type { IngestAdapter, PackTool } from '@mongrov/analytics'
import {
  addIdentityKey,
  definePack,
  ensureSchemas,
  quoteQualifier,
  registerPack,
  REMOTE_NAMESPACE,
  toLocalDdl,
} from '@mongrov/analytics'
import { z } from 'zod'

const WEATHER_DDL = `CREATE TABLE weather_reading (
  brand VARCHAR NOT NULL, family_id VARCHAR NOT NULL, user_id VARCHAR NOT NULL,
  device_id VARCHAR NOT NULL, station_id VARCHAR NOT NULL, ts TIMESTAMPTZ NOT NULL,
  wind_kph DOUBLE, rain_mm DOUBLE
) PARTITIONED BY (day(ts))`

interface StationReport {
  stationId: string
  samples: { at: string, windKph: number, rainMm: number }[]
}

const stationAdapter: IngestAdapter<StationReport> = {
  async ingest(raw, ctx) {
    return [['weather_reading', raw.samples.map(s => ({
      brand: ctx.brand,
      family_id: ctx.familyId,
      user_id: ctx.userId,
      device_id: ctx.deviceId,
      station_id: raw.stationId,
      ts: s.at,
      wind_kph: s.windKph,
      rain_mm: s.rainMm,
    }))]]
  },
}

const recentWind: PackTool = {
  description: 'Average wind speed over the last N days. Args: days (1..30).',
  inputSchema: z.object({ days: z.number().int().min(1).max(30) }),
  async impl({ days }, ctx) {
    const rows = await ctx.analytics.execute<{ avg_kph: number | null }>(
      `SELECT avg(wind_kph) AS avg_kph FROM v_weather_reading
        WHERE user_id = $userId AND ts > now() - INTERVAL (${days}) DAY`,
      { userId: ctx.requesterUserId },
    )
    const text = `Average wind over ${days} days: ${rows[0]?.avg_kph ?? 'no data'} kph`
    return { text, rowCount: rows.length, bytes: text.length }
  },
}

export const weatherPack = definePack({
  name: 'weather',
  tables: {
    weather_reading: {
      ddl: WEATHER_DDL,
      timeColumn: 'ts',
      syncable: true,
      retention: { tsColumn: 'ts', kind: 'sensor' },
      identity: ['user_id', 'device_id', 'ts'],
      view: true, // read through v_weather_reading
    },
  },
  // A pack creates its own tables in its first migration; later ones
  // must be idempotent (`ADD COLUMN IF NOT EXISTS`).
  migrations: [{
    version: 1,
    name: 'weather tables',
    async up(db, catalogs) {
      await ensureSchemas(db, catalogs.local, {
        weather_reading: addIdentityKey(toLocalDdl(WEATHER_DDL), ['user_id', 'device_id', 'ts']),
      })
      if (catalogs.remote)
        await ensureSchemas(db, `${quoteQualifier(catalogs.remote)}.${REMOTE_NAMESPACE}`, { weather_reading: WEATHER_DDL })
    },
  }],
  ingest: { station: stationAdapter },
  metrics: {
    wind_kph: { table: 'weather_reading', column: 'wind_kph', sampling_minutes: 10, exposure: 'full' },
    rain_mm: { table: 'weather_reading', column: 'rain_mm', sampling_minutes: 10, exposure: 'full' },
  },
  rules: {
    // A named context is a JOIN restricting the samples (`m` is the metric relation).
    contexts: {
      daytime: () => `INNER JOIN (SELECT 1 AS ok) d ON extract(hour FROM m.ts) BETWEEN 7 AND 19`,
    },
  },
  tools: { recentWind },
})

registerPack(weatherPack)
```

Then feed it from the sync pipeline:

```ts
await sync.sink.ingest('station', report, {
  brand: 'acme', familyId: 'fam_123', userId: 'user_1', deviceId: 'station_7',
})
```

and write rules against its metrics:

```ts
import { createRulesEngine, RuleSchema } from '@mongrov/analytics/rules'

const rules = createRulesEngine({ analytics: engine, storage: kv, familyMembersProvider, brand: 'acme', familyId: 'fam_123' })
await rules.register([RuleSchema.parse({
  id: 'acme.gusty-day',
  name: 'Gusty day',
  metric: 'wind_kph',
  window: '24h',
  aggregation: 'max',
  compare: 'greater_than',
  context: 'daytime',
  target: { type: 'absolute', value: 60 },
  severity: 'warn',
})])
rules.on('violation', v => notify(v))
```

Pack helpers: `getPacks`, `getPack`, `packTable`, `packTables`,
`viewedTables`, `ingestAdapter`, `packExtensions`, and for migrations
`ensureSchemas`, `listColumns`, `localDdlFor`, `hasLocalPrimaryKey`,
`addIdentityKey`, `toLocalDdl`, `qualifyDdl`, `quoteQualifier`,
`REMOTE_NAMESPACE`. Metric lookups: `metricDefinition`, `registeredMetricIds`,
`exposedMetricIds`, `collectedOnlyColumns`, `samplingLabelFor`. Relations
claims read: `readRelation`, `cleanRelation`, `qualityRelation`,
`hasQualityRelations`. Bounded reads: `boundedRelation`, `executeBounded`,
`executeBoundedRead`, `daysInterval`, `hoursInterval`.

## Engine API

### `createAnalytics(config, internal?): AnalyticsEngine`

Wires config + engine + XState machine. Kicks `OPEN` synchronously; the
engine is `opening` on the next tick. Registers `config.packs` in order.

### `AnalyticsEngine`

- `attach(ctx)` / `detach()`
- `execute(sql, params?)`, `stream(sql, params?)`, `createAppender(table)`
- `setRetention(days)` — persists the user override and re-runs the sweep
- `setQuality(opts)` — replaces the quality options the packs' views are
  built with; when attached, rebuilds those views and bounded macros at once
- `getFamilyMembers()`, `dismissInsight({ insightId, userId })`
- `getLastAttach(brand)` — the last attach context if under 24 h old
- `subscribe(listener)`, `close()`
- getters: `state`, `lastError`, `catalog`, `mode`, `boundedReads`

### Hooks and provider

`AnalyticsProvider`, `useAnalytics()`, `useTimeseries(key, sql, params?)`,
`useInsight(id)`.

### Config reference

| Field | Type | Notes |
|---|---|---|
| `mode?` | `'r2' \| 'local'` | Default `'r2'`. `'local'` omits the four R2 fields below. |
| `storage` | `KVStore` | 3-method structural type; supply `@mongrov/db` KVStore. |
| `warehouseUriBuilder` | `(brand, scope, tenantId) => string` | r2: the S3/Iceberg URI. |
| `catalogEndpoint` | `string` | r2: Iceberg REST endpoint used by `CREATE SECRET`. |
| `tokenVendor` | `TokenVendor` | r2: `.fetch({ brand, tenantScope, tenantId })` → token + `expiresAt`. |
| `familyMembersProvider` | `FamilyMembersProvider` | r2: family membership for rules, tools and retention. |
| `retention` | `Record<string, { days: number }>` | Brand-keyed default days for `sensor` tables. |
| `packs?` | `AnalyticsPack[]` | Registered at creation, in order. |
| `appSchema?` | `AppSchema` | App-owned tables. |
| `quality?` | `object` | Options for the packs' quality views. |
| `extensions?`, `dbPath?`, `duckdb?` | | DuckDB extensions, file path, `memoryLimit` / `threads`. |
| `eventBus?` | `EventBus` | Invalidation events. |
| `logger?` | `AnalyticsLogger` | `debug` / `info` / `warn` / `error`; defaults to a no-op. |

## State machine

```
idle → opening → ready → attaching → attached → detaching → ready
                          ↘ error ↙
```

- `opening` loads extensions (httpfs + iceberg + parquet in r2 mode).
- `attaching` attaches the warehouse (URI → token → `CREATE SECRET` →
  `ATTACH`), then runs each pack's migrations and builds views.
- `attached` refreshes the token at 75 % of its TTL.
- `error` is recoverable — call `attach()` again.

## Retention

```ts
effectiveDays = max(userOverride ?? 0, familySetting ?? 0, brandDefault)
```

Per table, from its `PackTable.retention`: `sensor` tables use
`effectiveDays`, `insight` tables 90 days, `audit` tables 30 days, `null`
never. A syncable table's DELETE is bounded by its push watermark, so rows
not yet pushed are never dropped. The sweep runs on every successful attach
and on every `setRetention`; an attach-time failure is logged, not thrown.

## Errors

Every failure is an `AnalyticsError` with a `code`: `engine_open_failed`,
`extension_load_failed`, `attach_failed`, `detach_failed`,
`token_vendor_failed`, `migration_failed`, `retention_failed`,
`family_members_failed`, `query_failed`, `not_attached`, `not_ready`,
`not_implemented`, `invalid_config`. `describeError(err)` flattens a cause
chain into one line.

## Sync (`@mongrov/analytics/sync`)

Device output → a pack's ingest adapter → buffer → `BatchFlusher` (serialised
per table) → local DuckDB → post-flush jobs → `batch:complete` →
`R2Pusher` → after-push hooks → `R2Fetcher` → `SyncScheduler`.

```tsx
import { createSyncManager, SyncProvider } from '@mongrov/analytics/sync'

const sync = createSyncManager({
  analytics: engine,
  storage: kv,
  ctx: { brand: 'acme', tenantScope: 'family', tenantId: 'fam_123', userId: 'user_1' },
  tables: ['weather_reading'],
  columnOrder: {
    weather_reading: ['brand', 'family_id', 'user_id', 'device_id', 'station_id', 'ts', 'wind_kph', 'rain_mm'],
  },
  prefetchPolicy: { kind: 'recent-active-only', activeDays: 30, windowDays: 90 },
  flush: { maxRows: 500, maxAgeMs: 60_000, concurrency: 3 },
  overflow: { maxBufferBytes: 5 * 1024 * 1024, policy: 'drop-oldest' },
  scheduler: { requiresCharging: false, requiresWifi: true, taskName: 'app.sync' },
  rulesEngine: rules, // optional: evaluate rules once per batch
})
await sync.start()
```

`SensorSink` (`sync.sink` or `useSensorSink()`): `push(batch)`,
`ingest(adapter, raw, ctx)`, `flush()`, `pendingRowCount(table?)`, `clear()`.
`SyncManager`: `start`, `stop`, `triggerNow`, `prefetch(ctx)`, `subscribe`,
`state`, `progress`. Hooks: `SyncProvider`, `useSyncManager`,
`useSensorSink`, `useSyncState`, `useSyncProgress`.

Other config: `eventBus`, `refreshToken`, `backgroundTask`
(`BackgroundTaskPort`), `constraints` (`ConstraintPort`, r2 mode only),
`strictBatchOrdering`, `userTimezoneProvider`, `computeBaselines`, `options`
(passed to the packs' post-flush jobs), `logger`, `appSchema`.

Prefetch policies: `all-family-on-attach`, `recent-active-only`, `lazy`.

Each scheduled cycle checks constraints (r2 mode only), flushes every table,
pushes, runs the packs' after-push hooks, then fetches. `triggerNow()`
bypasses the constraints.

## Rules (`@mongrov/analytics/rules`)

See [`src/rules/README.md`](https://github.com/mongrov/mongrov-packages/blob/master/packages/analytics/src/rules/README.md). `RuleSchema`,
`validateRule`, `compileRule`, `createRulesEngine`, `parseCatalog` (TOML
catalogs), `useRuleViolations`, `useRuleRegistry`.

A `user_setting` target's threshold (and a `phase_band` rule's scale) is read
from the app's `KVStore` under `userSettingKey(userId, key)`
(`analytics:<userId>:<key>`; exported from the root and `/rules`). Write the
setting under the same key:

```ts
import { userSettingKey } from '@mongrov/analytics'

await kv.set(userSettingKey(userId, 'user:windAlertKph'), 45)
```

## AI tools (`@mongrov/analytics/tools`)

`createAnalyticsTools({ analytics, ... })` wraps every registered pack's
tools plus the platform's `getInsights` in a `rate → authorize → execute →
budget → audit` chain and returns an AI SDK tool map. See
[`src/tools/README.md`](https://github.com/mongrov/mongrov-packages/blob/master/packages/analytics/src/tools/README.md).

`@mongrov/analytics/tools/mcp` exposes the same tools over Model Context
Protocol (stdio or HTTP with a bearer token), dev-only behind
`shouldStartMcpServer()`. See [`src/tools/mcp/README.md`](https://github.com/mongrov/mongrov-packages/blob/master/packages/analytics/src/tools/mcp/README.md).

## Testing

```bash
pnpm test               # unit suites (Vitest)
pnpm typecheck
pnpm build
pnpm test:integration   # live MinIO + Iceberg REST stack (docker)
```

The package's suites run the engine with test packs
(`src/__tests__/packs/`). The integration stack is described in
[`infra/analytics-minio/README.md`](https://github.com/mongrov/mongrov-packages/blob/master/packages/analytics/infra/analytics-minio/README.md)
(repository only). `@duckdb/node-api` is a devDependency only.

## Testing your app

A jest or vitest mock of `@mongrov/analytics` stubs what needs the native
engine (`createAnalytics`, the provider and hooks, `createSyncManager`) but
still needs the real pack registry: a domain pack calls `definePack` /
`registerPack` and builds its DDL with the helpers when it loads.
`@mongrov/analytics/testing` exports those pure modules — no native module,
no React, no domain, no side effect on import — under the same names as the
root and `/sync` exports, and the same module instances:

```ts
// __mocks__/@mongrov/analytics.ts
export * from '@mongrov/analytics/testing'

export const createAnalytics = jest.fn(() => ({ attach: jest.fn(), detach: jest.fn(), close: jest.fn(), state: 'ready' }))
export const AnalyticsProvider = ({ children }: { children: React.ReactNode }) => children
// …stubs for the rest of the surface your app uses
```

What it exports: the pack registry (`definePack`, `registerPack(s)`,
`getPack(s)`, `packTable(s)`, `viewedTables`, `ingestAdapter`,
`packExtensions`, and `resetPacks` for isolation between tests); DDL and
schema helpers (`addIdentityKey`, `qualifyDdl`, `quoteQualifier`,
`toLocalDdl`, `ensureSchemas`, `localDdlFor`, `hasLocalPrimaryKey`,
`generateViewDdl`, `dropViewDdl`, `watermarkColumnFor`, `listColumns`,
`REMOTE_NAMESPACE`); app schemas (`validateAppSchema`, `ensureAppSchema`,
`appSchemaVersionKey`); the platform tables (`PLATFORM_TABLES`,
`PLATFORM_SCHEMAS`, `PLATFORM_TABLE_NAMES`); metric and relation lookups
(`metricDefinition`, `registeredMetricIds`, `exposedMetricIds`,
`collectedOnlyColumns`, `samplingLabelFor`, `readRelation`, `cleanRelation`,
`qualityRelation`, `hasQualityRelations`, `isSyncable`, `timeColumnFor`);
bounded reads (`boundedRelation`, `executeBounded`, `executeBoundedRead`,
`daysInterval`, `hoursInterval`, `FORWARD_DAYS`, `SPARE_DAYS`,
`BOUNDED_FAILURE_LIMIT`); errors (`AnalyticsError`, `NotImplementedError`,
`describeError`); `tailId`; `userSettingKey`; and from `/sync`
`createBaselineRunner`, `DROPPED_ROWS_EVENT`, `DropTally`, `validateRows`,
`mergeFlushResults`, `logError` — with their types.

## Boundaries

- No dependency on BLE, `@mongrov/device`, `@mongrov/collab` or UI packages.
- No value-level import from `@mongrov/db`; `KVStore` is structural.
- No logs on the hot query path.
- A persistence or retention failure never rejects a good attach.

## License

MIT
