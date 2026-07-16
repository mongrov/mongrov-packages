# `analytics-minio` — local + CI stack for integration tests

Docker-compose recipe that boots the three services `@mongrov/analytics`
integration tests need:

| Service | Image | Host port | Purpose |
|---|---|---|---|
| `minio` | `minio/minio:RELEASE.2025-04-08T15-41-24Z` | `9000` (S3), `9001` (console) | S3-compatible object storage — Iceberg data + manifests |
| `minio-init` | `minio/mc:RELEASE.2025-04-08T15-39-49Z` | — | One-shot init: creates the `warehouse` bucket then exits |
| `iceberg-rest` | `tabulario/iceberg-rest:1.6.0` | `8181` | Iceberg REST catalog (JDBC/SQLite-backed metadata, S3 file IO) |

All ports pinned to specific host ports so tests can rely on stable
URLs. See "Port collisions" below if you already run MinIO or similar
locally.

## Credentials (test-only, hard-coded)

- Access key: `minio`
- Secret key: `minio-testing-password`
- Bucket:    `warehouse`
- Catalog:   `http://localhost:8181` (Iceberg REST API v1)
- Region:    `us-east-1` (arbitrary; MinIO ignores it)

These are literally in the compose file — **do not** reuse for anything
non-test.

## Usage

### One-shot (CI-style)

`pnpm --filter @mongrov/analytics run test:integration` boots + tears down
the stack automatically via Vitest `globalSetup`. Nothing to run
manually. Costs ~30s on cold pull + ~10s on warm.

### Iterative (local dev)

Bring the stack up once, then re-run tests without paying compose boot:

```bash
cd packages/analytics/infra/analytics-minio
docker compose up -d --wait

# Repeat as many times as you like — stack stays up:
cd ../..
INTEGRATION_STACK_EXTERNAL=1 pnpm test:integration

# Done:
cd infra/analytics-minio
docker compose down -v
```

The `INTEGRATION_STACK_EXTERNAL=1` env var tells `globalSetup` to skip
its own up/down calls and assume you already brought the stack up.

## Verifying the stack is healthy

```bash
# REST catalog answering:
curl -sf http://localhost:8181/v1/config
# → {"defaults":{},"overrides":{}}

# Bucket exists:
docker run --rm --network mongrov-analytics-minio_default \
  --entrypoint /bin/sh minio/mc:RELEASE.2025-04-08T15-39-49Z \
  -c 'mc alias set local http://minio:9000 minio minio-testing-password >/dev/null && mc ls local/'
# → [...] warehouse/

# MinIO console (browser):
open http://localhost:9001    # user: minio / password: minio-testing-password
```

## Port collisions

If a port is already bound (e.g. Confluent kafka-rest sits on 8181, or
you already run local MinIO on 9000), override at invocation time:

```bash
COMPOSE_PROJECT_NAME=analytics-test MINIO_PORT=9100 REST_PORT=8281 \
  docker compose -f docker-compose.yml up -d --wait
```

The compose file today uses fixed ports; if you need variable ports as
a routine developer experience, land a follow-up PR templating them via
`${MINIO_PORT:-9000}` etc. Right now the assumption is *nothing else on
these ports* — verified via `lsof -iTCP:9000 -sTCP:LISTEN` etc.

## Healthcheck notes

`tabulario/iceberg-rest:1.6.0` ships a slim JDK-only image — **no `wget`,
`curl`, `nc`, or `busybox`**. The healthcheck uses bash's `/dev/tcp`
pseudo-file to probe port 8181 instead of the more common HTTP probe.

## Warehouse layout

After `iceberg-rest` creates its first namespace + table:

```
s3://warehouse/
├── <namespace>.db/
│   └── <table>/
│       ├── metadata/       # Iceberg JSON metadata + manifest lists
│       └── data/           # Parquet files
```

## Tear-down

`docker compose down -v` deletes the MinIO volume — every subsequent
`up` starts with an empty warehouse and empty catalog. This is
intentional: tests own their data.

## When to bump image tags

| Trigger | What to do |
|---|---|
| Production DuckDB Iceberg reader version changes | Match `iceberg-rest` catalog version to avoid protocol drift |
| MinIO API changes | Bump both `minio/minio` and `minio/mc` in lockstep |
| CI flake caused by transient image bug | Pin to a specific `-sha256:...` digest until upstream fixes |

Rule: pins should be explicit versions (never `:latest`) so CI is
reproducible from HEAD.
