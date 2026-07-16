# `__integration__` — live-warehouse test harness

This directory holds the plumbing that lets Vitest boot a real MinIO +
Iceberg REST stack and drive the shipped `createAnalytics()` factory
against it. It's **not** part of the production build — `tsconfig.build.json`
excludes `src/__integration__/**` and the sole native dep it uses
(`@duckdb/node-api`) stays in `devDependencies`.

## What's here

```
setup/
├── endpoints.ts        Reads env + defaults, exposes { restEndpoint,
│                       s3Endpoint, warehouseName, s3AccessKey, ... }
│                       used by every test helper.
├── global-setup.ts     Vitest globalSetup — boots docker-compose, waits
│                       for MinIO + iceberg-rest health, tears down on
│                       teardown. Honours INTEGRATION_STACK_EXTERNAL=1.
├── global-teardown.ts  (Bundled inside global-setup.ts as the teardown
│                       export for the Vitest v2 API.)
├── real-engine.ts      Adapter from @duckdb/node-api to the internal
│                       DuckDBInstance seam. Installs the iceberg +
│                       httpfs extensions on connect.
└── seed.ts             Test-side helpers: ensureNamespace/dropNamespace
                        (Iceberg REST v1), ensureS3Secret (DuckDB TYPE
                        S3 for MinIO), staticTokenVendor,
                        refreshingTokenVendor, memoryKV, seedHrvRows.
```

## Architecture

The two integration suites (`src/core/__tests__/minio.integration.test.ts`
and `src/sync/__tests__/push-fetch.integration.test.ts`) both:

1. Import `createAnalytics()` — the same public factory the app uses.
2. Substitute two things via `createAnalytics()`'s hidden 2nd arg
   (`CreateAnalyticsInternal`):
   - `duckdbFactory`: `createRealDuckDB()` from `real-engine.ts` — Node
     native DuckDB instead of `react-native-duckdb`.
   - Inside the factory closure, `ensureS3Secret()` runs against the
     new instance so DuckDB can read Parquet from MinIO before the
     first ATTACH.
3. Everything else — the machine, migrations, warehouse handshake,
   retention sweep, sync push/fetch — runs unmodified.

That's the guarantee: **integration tests exercise production code
paths, not a stub**.

## Divergences from production (deliberate)

| Path | Production | Integration | Why |
|---|---|---|---|
| DuckDB engine | `react-native-duckdb` | `@duckdb/node-api` (dev-only) | Native RN adapter can't run in Node/CI. |
| S3 credentials | Vended by REST catalog response (R2) | Separate `TYPE S3` secret to MinIO | Tabular `iceberg-rest` doesn't vend creds; the app's R2 catalog does. |
| Token vendor | App auth backend | `staticTokenVendor()` or `refreshingTokenVendor()` | Deterministic, spy-friendly. |
| Warehouse URI | Per-tenant R2 path | Single MinIO bucket for all tenants | MinIO doesn't proxy per-tenant paths; we assert on catalog-alias isolation, not object-store isolation. |

## Adding a new integration test

1. Name it `*.integration.test.ts` — Vitest routes it to the
   `vitest.integration.config.ts` include list (unit suite excludes
   this glob).
2. Boot the engine with `createAnalytics()` + the internal `duckdbFactory`
   pattern from either existing suite.
3. Reset any shared MinIO state at the *start* of the test — the
   compose volume persists across `INTEGRATION_STACK_EXTERNAL=1`
   iterative runs, so tests must be idempotent (see `resetHrv` /
   `resetRemote` patterns in the existing suites).
4. Prefer the shared helpers in `setup/seed.ts` over rolling your own.

## Running

See `packages/analytics/infra/analytics-minio/README.md` for the
docker-compose lifecycle. Then:

```bash
# From packages/analytics/
pnpm test:integration                            # boots + tears down
INTEGRATION_STACK_EXTERNAL=1 pnpm test:integration  # requires you to run docker compose up -d --wait first
```

## Non-goals

- **Full CI coverage of every table**: today only `hrv` is used because
  it's the simplest schema and any Iceberg type-mapping surprises will
  show up there first. Adding coverage for `sleep_session` or
  `device_config` (composite PKs) is worth doing when their code paths
  land.
- **Fake-timer / mock-clock testing**: kept out on purpose — the
  75%-TTL refresh test uses real wall-clock sleeps (4s TTL) so the
  xstate `after` delay behaves as it would in production.
- **Load / soak testing**: this suite proves correctness, not
  throughput. Perf work belongs in a separate benchmark harness.
