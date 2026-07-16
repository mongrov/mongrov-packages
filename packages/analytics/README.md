# @mongrov/analytics

DuckDB + R2 Iceberg local analytics for React Native / Expo apps in the Mongrov platform.

Per-family (or per-tenant) warehouses attached as DuckDB catalogs. Zero-copy
reads against R2 Iceberg tables. Headless core with optional React hooks and
UI subpaths.

Status: **0.1.0-alpha.7** — Phases 1 → 7 landed on the core engine plus the
full `@mongrov/analytics/sync` subpath (mapper → buffer → flusher → watermark
→ pusher → fetcher → scheduler → factory + hooks). MinIO integration test
(T-18 / T-28) and app-kill e2e (T-29) still pending; `0.1.0` publish (T-20)
follows once integration coverage lands.

## Features

- **Adapter-friendly DuckDB engine** — `HybridDuckDB` wrapper with pluggable
  `DuckDBFactory` so tests can substitute an in-memory fake.
- **Per-tenant Iceberg warehouse** — `CREATE SECRET` + `ATTACH ... (TYPE ICEBERG)`
  for a single `zone_<tenantId>` catalog per attach.
- **Migration runner** — versioned per `(brand, tenantId)`, idempotent, KV-tracked.
- **Retention scheduler** — `max(userOverride, familySetting, brandDefault)`
  precedence; sensor tables use effective days, `insight` 90d, `tool_call_audit`
  30d; DELETE bounded by `sync_watermark` so unsynced rows never drop.
- **KV persistence** — last-attach ctx restored across restarts (24h TTL);
  per-user retention override.
- **XState v5 state machine** — `idle → opening → ready → attaching → attached
  → detaching → error` with token-refresh actor at 75% TTL.
- **React hooks + provider** — `useAnalytics`, `useTimeseries`, `useInsight`,
  `AnalyticsProvider`.
- **Structured logger** — supply an `AnalyticsLogger` via config; falls back
  to a no-op sink. No logs on the hot query path.
- **Typed error taxonomy** — `AnalyticsError` with a code union covering every
  failure mode (`engine_open_failed`, `attach_failed`, `detach_failed`,
  `token_vendor_failed`, `migration_failed`, `retention_failed`, `query_failed`,
  `not_attached`, `not_ready`, `not_implemented`, `extension_load_failed`).

## Install

```bash
pnpm add @mongrov/analytics
# Peer deps
pnpm add react-native-duckdb @mongrov/db @mongrov/types
```

`react-native-duckdb` is declared as an **optional peer** — the package boots
lazily so importing `createAnalytics` on a Node/CI host without the native
module does not throw. Failure to resolve it surfaces on `open()` as
`AnalyticsError('engine_open_failed')`.

## Quick Start

```tsx
import { AnalyticsProvider, createAnalytics, useAnalytics } from '@mongrov/analytics'
import type { AnalyticsConfig } from '@mongrov/analytics'

const config: AnalyticsConfig = {
  storage: kv, // @mongrov/db KVStore or any structural equivalent
  warehouseUriBuilder: (brand, scope, tenantId) =>
    `s3://mongrov-analytics/${brand}/${tenantId}/warehouse`,
  catalogEndpoint: 'https://catalog.mongrov.example',
  tokenVendor: {
    async fetch({ brand, tenantScope, tenantId }) {
      const response = await api.getWarehouseToken({ brand, tenantScope, tenantId })
      return { token: response.token, expiresAt: new Date(response.expiresAt) }
    },
  },
  familyMembersProvider: async ({ brand, familyId }) => {
    return api.listFamilyMembers({ brand, familyId })
  },
  retention: {
    ziva: { days: 180 },
    luminx: { days: 90 },
  },
  logger: appLogger, // optional; defaults to a no-op
}

const engine = createAnalytics(config)

function App() {
  return (
    <AnalyticsProvider engine={engine}>
      <MyDashboard />
    </AnalyticsProvider>
  )
}

function MyDashboard() {
  const { state, attach, isAttached } = useAnalytics()

  useEffect(() => {
    if (!isAttached) {
      attach({
        brand: 'ziva',
        tenantScope: 'family',
        tenantId: 'fam_123',
        userId: 'user_1',
      })
    }
  }, [isAttached, attach])

  return <Text>State: {state}</Text>
}
```

## Public API

### `createAnalytics(config: AnalyticsConfig): AnalyticsEngine`

Wires config + engine + XState machine into an `AnalyticsEngine`. Kicks
`OPEN` synchronously; the returned engine is `opening` on the next tick.

### `AnalyticsProvider`

React context provider. Wrap once at the app root with a shared engine
instance so hooks can consume it.

### `useAnalytics(): UseAnalyticsResult`

Subscribes to state transitions via `useSyncExternalStore`. Returns:

```ts
type UseAnalyticsResult = {
  state: AnalyticsState
  isReady: boolean
  isAttached: boolean
  error: Error | null
  attach: (ctx: AttachContext) => Promise<void>
  detach: () => Promise<void>
  execute: AnalyticsEngine['execute']
  stream: AnalyticsEngine['stream']
  setRetention: (days: number) => Promise<void>
}
```

### `useTimeseries<T>(key, params?)`

Reactive query hook. Runs on mount when engine is attached; re-runs on ctx or
key change; supports manual `refetch`; exposes loading + error state.

### `useInsight<T>(id)`

Reads a single row from the `insight` table by `id`. Returns `undefined`
if not found.

### `AnalyticsEngine`

Full method surface:

- `attach(ctx: AttachContext): Promise<void>`
- `detach(): Promise<void>`
- `execute(sql, params?): Promise<Row[]>`
- `stream(sql, params?): AsyncIterable<Row>`
- `createAppender(table): AnalyticsAppender`
- `setRetention(days: number): Promise<void>` — persists user override and
  re-runs sweep with the effective value
- `getLastAttach(brand: string): Promise<AttachContext | null>` — restore
  ctx from KV (null when older than 24h)
- `subscribe(listener): Unsubscribe`
- `close(): Promise<void>`
- getters: `state`, `lastError`, `catalog`

## Config Reference

| Field | Type | Notes |
|---|---|---|
| `storage` | `KVStore` | 3-method structural type; supply `@mongrov/db` KVStore. |
| `warehouseUriBuilder` | `(brand, scope, tenantId) => string` | Returns the S3/Iceberg URI. |
| `catalogEndpoint` | `string` | Iceberg REST endpoint used by `CREATE SECRET`. |
| `tokenVendor` | `TokenVendor` | `.fetch({ brand, tenantScope, tenantId })` returns bearer token + `expiresAt`. |
| `familyMembersProvider` | `FamilyMembersProvider` | Called only when `tenantScope === 'family'`; primes retention math. |
| `retention` | `Record<string, { days: number }>` | Brand-keyed defaults. Sensor tables use `max(userOverride, familySetting, brandDefault)`; `insight` = 90d fixed; `tool_call_audit` = 30d fixed. |
| `logger?` | `AnalyticsLogger` | 4 levels (`debug` / `info` / `warn` / `error`); defaults to a no-op sink. |

## State Machine

```
idle → opening → ready → attaching → attached → detaching → ready
                          ↘ error ↙
```

- `opening` runs `bootstrapExtensions()` (httpfs + iceberg + parquet).
- `attaching` runs `attachWarehouse` (URI builder → token fetch → CREATE
  SECRET → ATTACH → optional family-members prime) then `ensureMigrations`.
- `attached` self-schedules a token refresh at 75% TTL via
  `CREATE OR REPLACE SECRET`.
- `error` is recoverable — re-issue `OPEN` (or `attach()` from userland).

## Retention

Precedence per spec (any layer that preserves data wins):

```ts
effectiveDays = max(userOverride ?? 0, familySetting ?? 0, brandDefault)
```

Per-table SQL:

```sql
DELETE FROM {catalog}.{table}
 WHERE {tsCol} < LEAST(
   now() - INTERVAL '{days} days',
   (SELECT MAX(cursor_ts) FROM {catalog}.sync_watermark WHERE table_name = '{table}')
 );
```

- `MAX(cursor_ts)` returns NULL when nothing has synced → `LEAST(_, NULL) = NULL`
  → `ts < NULL` is FALSE → unsynced rows preserved.
- Sensor tables (hrv, heart_rate, spo2, temperature, activity, activity_bucket,
  sleep_session, sleep_stage, sleep_raw, device_event) use `effectiveDays`.
- `sleep_session` sweeps by `ts_end` (session close), not `ts_start`.
- `insight` sweeps at 90d fixed.
- `tool_call_audit` sweeps at 30d fixed.
- `device_config` + `sync_watermark` are skipped.

Retention sweep runs automatically on every successful `attach()` and on every
`setRetention()` call. Failures raise `AnalyticsError('retention_failed', …)`;
the attach-time sweep swallows and logs via `warn` so a DELETE failure never
rejects a good attach.

## Persistence

- **Last-attach:** `analytics:last-attach:{brand}` → `{ ctx, savedAt }`.
  Expires after 24h; `loadLastAttach` deletes stale entries as a side effect.
- **Retention override:** `analytics:retention:override:{brand}:{tenantId}:{userId}`
  → `number`. Overwrites cleanly on `setRetention()`.

Both writes inside `attach()` and `setRetention()` are best-effort; failure
surfaces as a `logger.warn(...)` call, never a rejected promise on the caller.

## Logging

The library only emits at these levels:

- **debug** — state transitions on every distinct value change
  (`analytics.state { value }`)
- **info** — lifecycle milestones (`analytics.attached`, `analytics.detached`,
  `analytics.closed`)
- **warn** — best-effort catches (`analytics.persist.last_attach_failed`,
  `analytics.persist.clear_last_attach_failed`, `analytics.retention.sweep_failed`)
- **error** — reserved for callers who want to surface an `AnalyticsError`
  before re-throwing; not used by the library today.

Nothing is emitted on the hot query path (`execute`, `stream`, `createAppender`).
Supply your own logger to trace at your integration layer if needed.

## Error Taxonomy

Every failure surfaces as an `AnalyticsError` with a discriminating `code`:

| Code | Origin |
|---|---|
| `engine_open_failed` | DuckDB factory or `open()` threw. |
| `extension_load_failed` | httpfs / iceberg / parquet install/load failed. |
| `attach_failed` | Any step of the attach protocol (URI, secret, ATTACH, family). |
| `detach_failed` | `DETACH` or `DROP SECRET`. |
| `token_vendor_failed` | `tokenVendor.fetch(...)` or refresh CREATE OR REPLACE SECRET. |
| `migration_failed` | Any migration step; KV rolled back to `n-1`. |
| `retention_failed` | `runRetentionSweep` DELETE threw. |
| `query_failed` | `execute` / `stream` native error. |
| `not_attached` | Caller invoked `setRetention` before attach. |
| `not_ready` | Query issued on a closed / non-open engine. |
| `not_implemented` | Stub not yet wired (rare in 0.1.0-alpha.5). |

## Testing

The package ships with 125 unit tests across 14 files (Vitest). Fakes for the
DuckDB instance, KV store, machine actors, and attach dependencies live in
`src/core/__tests__/__fakes__/`.

```bash
pnpm test           # single run
pnpm test --watch   # watch mode
pnpm typecheck      # tsc --noEmit
pnpm build          # tsc -p tsconfig.build.json
```

**Fake DuckDB** — captures every issued SQL for assertions and scripts return
values or errors:

```ts
import { createFakeDuckDB } from '@mongrov/analytics/__tests__/__fakes__/fake-duckdb'

const fake = createFakeDuckDB()
fake.failNextExecute(new Error('disk full'))
fake.failExecuteMatching(/^DELETE FROM /, new Error('retention sad'))
```

**Fake KV** — in-memory `KVStore` implementation with the backing map
exposed for direct assertions.

## Integration testing (T-18 — pending)

Full end-to-end coverage against a real MinIO + Iceberg REST catalog is
planned for T-18 in Phase 8. The intended shape:

1. Boot MinIO + Iceberg REST via testcontainers.
2. `createAnalytics` with a real `duckdbFactory` and pointing at the test
   endpoint.
3. `attach → INSERT (via appender) → SELECT → detach → reattach` — assert
   no leakage.
4. Brand-switch scenario: attach `brandA`, detach, attach `brandB`, confirm
   no cross-brand catalog visibility.

This suite is deferred until testcontainers infra lands.

## Boundaries

- **No** direct dependencies on `react-native-ble-plx`, `@mongrov/device`,
  `@mongrov/collab`, or any UI-only package.
- **No** value-level import from `@mongrov/db` — the `KVStore` contract is a
  local structural type so this package can be consumed alone.
- **No** logs on the hot query path.
- **No** rejection of a successful attach for persistence / retention failures.

## Sync (`@mongrov/analytics/sync`)

The `/sync` subpath layers the write-side pipeline on top of the core engine:
firmware/live rows → mapper → in-memory ring buffer → BatchFlusher (p-queue
serialised per table) → local DuckDB → R2Pusher → R2Fetcher (incremental /
prefetch) → SyncScheduler (`expo-background-task`-friendly cycle).

### Quick wiring

```tsx
import { createAnalytics } from '@mongrov/analytics'
import {
  createSyncManager,
  SyncProvider,
  useSensorSink,
  useSyncProgress,
  useSyncState,
} from '@mongrov/analytics/sync'

const analytics = createAnalytics(analyticsConfig)

const sync = createSyncManager({
  analytics,
  storage: kv,
  ctx: { brand: 'ziva', tenantScope: 'family', tenantId: 'fam_123', userId: 'u1' },
  tables: [
    'hrv', 'heart_rate', 'spo2', 'temperature',
    'activity', 'activity_bucket',
    'sleep_session', 'sleep_stage', 'sleep_raw',
    'device_event', 'device_config',
  ],
  columnOrder: {
    hrv: ['user_id', 'device_id', 'ts', 'rmssd_ms', 'sdnn_ms'],
    // …one entry per table matching the Iceberg column order.
  },
  prefetchPolicy: { kind: 'recent-active-only', activeDays: 30, windowDays: 90 },
  flush: { maxRows: 500, maxAgeMs: 60_000, concurrency: 3 },
  overflow: { maxBufferBytes: 5 * 1024 * 1024, policy: 'drop-oldest' },
  scheduler: { requiresCharging: false, requiresWifi: true, taskName: 'mongrov.sync' },
  eventBus: appEventBus, // optional
  refreshToken: analytics.refreshToken, // optional
})

await sync.start()

export default function App() {
  return (
    <AnalyticsProvider engine={analytics}>
      <SyncProvider manager={sync}>
        <Root />
      </SyncProvider>
    </AnalyticsProvider>
  )
}
```

### SensorSink API

`useSensorSink()` (or `sync.sink`) returns:

- `push(batch: SensorBatch): Promise<void>` — enqueue a pre-mapped batch.
- `pushFirmware(fw: FirmwareExport, ctx: MapperContext): Promise<void>` —
  runs the firmware mapper (`mapFirmwareExport`) and fans out per table.
- `flush(): Promise<FlushResult[]>` — drain every configured table now.
- `pendingRowCount(table?: string): Promise<number>` — in-memory + overflow.
- `clear(): Promise<void>` — reset buffer + overflow (used on sign-out).

### Config reference (sync)

| Field | Type | Notes |
|---|---|---|
| `analytics` | `AnalyticsEngine` | Core engine created by `createAnalytics(...)`. |
| `storage` | `KVStore` | Backing store for overflow chunks + watermarks. |
| `ctx` | `AttachContext` | Passed to scheduler cycle (pushAll / fetchIncremental). |
| `tables` | `readonly string[]` | Ordered list; enforces flush / push / fetch scope. |
| `columnOrder` | `Record<string, readonly string[]>` | Column order per table; must match Iceberg schema. |
| `prefetchPolicy` | `PrefetchPolicy` | `all-family-on-attach` / `recent-active-only` / `lazy`. |
| `flush.maxRows` | `number` | Row-count trigger (default 500). |
| `flush.maxAgeMs` | `number` | Age trigger (default 60 000 ms). |
| `flush.concurrency` | `number` | p-queue concurrency (default 3). |
| `overflow.maxBufferBytes` | `number` | Ring budget before spill. |
| `overflow.policy` | `'drop-oldest' \| 'drop-newest' \| 'block'` | Overflow strategy. |
| `scheduler.requiresCharging` | `boolean` | Skip cycle unless charging. |
| `scheduler.requiresWifi` | `boolean` | Skip cycle unless Wi-Fi. |
| `scheduler.taskName` | `string` | Background-task registration name. |
| `eventBus?` | `EventBus` | Optional bus for `{table}:insert` / `{table}:sync_complete` fan-out. |
| `refreshToken?` | `() => Promise<void>` | Called by pusher on `401 token_expired` before retry. |
| `backgroundTask?` | `BackgroundTaskPort` | Inject a native background port (defaults to an in-process no-op). |
| `constraints?` | `ConstraintPort` | Inject Wi-Fi + charging probes (defaults to always-allowed). |
| `logger?` | `SchedulerLogger` | Debug hook for the scheduler cycle. |

### Prefetch policies

- `{ kind: 'all-family-on-attach', windowDays }` — pull the last `windowDays`
  of every configured table for the whole family after attach.
- `{ kind: 'recent-active-only', activeDays, windowDays }` — only pull for
  users active within `activeDays`, capped at `windowDays`.
- `{ kind: 'lazy' }` — no prefetch; `fetchIncremental` picks up from the
  fetch watermark on the first scheduler cycle.

Call `sync.prefetch(ctx)` right after `analytics.attach(ctx)` completes.

### Background scheduling

`SyncScheduler` registers a single task (`config.scheduler.taskName`) with
the injected `BackgroundTaskPort`. Every registered cycle:

1. Constraint check (Wi-Fi + optional charging). Missing constraints emit
   `constraint_not_met` and skip.
2. `coordinator.flushAll()` — parallel `flusher.flush(table, 'scheduled')`.
3. `coordinator.pushAll(tables, ctx)` — `R2Pusher.pushAll` (concurrency-safe).
4. `coordinator.fetchIncremental(ctx)` — `R2Fetcher.fetchIncremental`.

`sync.triggerNow()` bypasses constraints (e.g., manual "sync now" button).
`sync.subscribe(fn)` fans out scheduler transitions (`idle | running | error`).

### Mapper contract

`@mongrov/analytics/sync` exposes per-metric mappers plus a firmware-export
fan-out:

- `mapHrv`, `mapHeartRate`, `mapSpo2`, `mapTemperature`, `mapActivity`,
  `mapBattery`, `mapRingConfig`, `reconstructSleepSessions` — one per raw
  metric family.
- `mapFirmwareExport(fw, ctx)` — runs every applicable mapper and returns a
  `FirmwareMappedBatch` keyed by table (matches `sync.sink.pushFirmware`).

Row types (`HrvRow`, `HeartRateRow`, …, `SleepSessionRow`) are re-exported
for typed sinks / adapters. `computeNightOf` + `parseTimestamp` cover the
common time helpers.

### Firmware fixtures

Fixture exports used across mapper + firmware tests live at
`src/sync/__tests__/__fixtures__/` (e.g. `firmware-full-day.json`).
Consumers writing their own regression tests can import them via a relative
path inside this workspace; they are excluded from the published `dist/`.

## AI tools (`@mongrov/analytics/tools`)

Six read-only AI SDK v4 tools (`getHRV`, `getSleepSummary`,
`getActivityTotal`, `compareTrend`, `detectAnomaly`, `getInsights`)
sit on top of the warehouse, wired through a
`rate → auth → execute → budget → audit` chain. See
[`src/tools/README.md`](./src/tools/README.md).

### MCP dev server (`@mongrov/analytics/tools/mcp`)

Same six tools, exposed over Model Context Protocol via stdio
(Claude Desktop) or HTTP with bearer auth (MCP Inspector, curl).
Dev-guarded (`shouldStartMcpServer()`) + `sideEffects: false` so
prod RN bundles drop the SDK. See
[`src/tools/mcp/README.md`](./src/tools/mcp/README.md).

## License

MIT
