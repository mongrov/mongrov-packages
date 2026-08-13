/**
 * `seed.ts` — test-side helpers for setting up + tearing down
 * Iceberg-REST namespaces, wiring an `AnalyticsConfig` that points at
 * the docker-compose stack, and pushing rows into local (memory-catalog)
 * tables via the appender.
 *
 * Divergence from production worth calling out:
 *
 * - Production (`src/core/warehouse.ts`) creates a single DuckDB SECRET
 *   of `TYPE ICEBERG`, and the R2 REST catalog response includes an
 *   ephemeral S3 credential that DuckDB uses to fetch Parquet data
 *   files directly. The Tabular `iceberg-rest` container we use for
 *   tests does NOT vend S3 creds — it expects the client to have its
 *   own. So integration tests additionally create a `TYPE S3` secret
 *   scoped to the MinIO endpoint before attach.
 *
 *   `ensureS3Secret()` is called from test setup, NOT from production
 *   code paths.
 *
 * - Production tokens come from the app's auth backend. Tests use
 *   `staticTokenVendor()` (or `refreshingTokenVendor()` for T-18 case
 *   #5) so we can pin token content and observe refresh calls.
 */

import type { DuckDBInstance } from '../../core/engine'
import type {
  AnalyticsConfig,
  KVStore,
  TokenResponse,
  TokenVendor,
} from '../../core/types'
import type { Endpoints } from './endpoints'

// -------------------- REST catalog admin --------------------

/**
 * Create a namespace via the Iceberg REST v1 protocol.
 *
 * The container answers `POST /v1/namespaces` with 200/409; 409 means
 * "already exists" which we treat as success (namespace bootstrapping
 * is idempotent from the suite's perspective).
 *
 * Uses `fetch` — available under Node 20+ (the version the CI matrix
 * uses).
 */
export async function ensureNamespace(
  rest: string,
  namespace: string,
): Promise<void> {
  const res = await fetch(`${rest}/v1/namespaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ namespace: [namespace] }),
  })
  if (res.ok || res.status === 409)
    return
  const text = await res.text()
  throw new Error(`ensureNamespace(${namespace}) failed: ${res.status} ${text}`)
}

/** DELETE the namespace (and every table under it) — for teardown / brand isolation tests. */
export async function dropNamespace(
  rest: string,
  namespace: string,
): Promise<void> {
  // List tables, drop each, then drop the namespace itself.
  const list = await fetch(`${rest}/v1/namespaces/${namespace}/tables`)
  if (list.ok) {
    const body = (await list.json()) as { identifiers?: { name: string }[] }
    for (const id of body.identifiers ?? []) {
      await fetch(`${rest}/v1/namespaces/${namespace}/tables/${id.name}`, {
        method: 'DELETE',
      })
    }
  }
  const res = await fetch(`${rest}/v1/namespaces/${namespace}`, {
    method: 'DELETE',
  })
  if (!res.ok && res.status !== 404) {
    throw new Error(`dropNamespace(${namespace}) failed: ${res.status}`)
  }
}

// -------------------- DuckDB-side prerequisites --------------------

/**
 * Create the DuckDB `TYPE S3` secret that gives DuckDB creds to read
 * Parquet files from MinIO. See the divergence note at file top.
 *
 * Uses parameterised secret creation so credentials never appear in
 * the query log.
 */
const SCHEME_PREFIX_RE = /^https?:\/\//

export async function ensureS3Secret(
  db: DuckDBInstance,
  ep: Endpoints,
): Promise<void> {
  // MinIO speaks the S3 API over plain HTTP on localhost — set URL_STYLE
  // to 'path' and disable SSL so DuckDB doesn't wrap the URL in `https://`.
  const endpointHost = ep.s3Endpoint.replace(SCHEME_PREFIX_RE, '')
  await db.execute(
    `CREATE OR REPLACE SECRET minio_s3 (
       TYPE S3,
       KEY_ID $key,
       SECRET $secret,
       REGION $region,
       ENDPOINT $endpoint,
       URL_STYLE 'path',
       USE_SSL false
     )`,
    {
      key: ep.s3AccessKey,
      secret: ep.s3SecretKey,
      region: ep.s3Region,
      endpoint: endpointHost,
    },
  )
}

// -------------------- Test config wiring --------------------

/**
 * Minimal in-memory KVStore for the analytics config. Every test-scope
 * factory call gets a fresh one (state doesn't leak across tests).
 */
export function memoryKV(): KVStore {
  const m = new Map<string, unknown>()
  return {
    async get<T>(k: string) {
      return m.get(k) as T | undefined
    },
    async set<T>(k: string, v: T) {
      m.set(k, v)
    },
    async delete(k: string) {
      m.delete(k)
    },
  }
}

/**
 * Vend a fixed token that never expires (10 minutes from now). Good
 * enough for T-18 cases #1–#4; case #5 (refresh) uses `refreshingTokenVendor`.
 */
export function staticTokenVendor(token = 'test-token'): TokenVendor {
  return {
    async fetch() {
      return {
        token,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        scopeClaims: {
          brand: 'ziva',
          tenantScope: 'family',
          tenantId: 'fam_test',
          permissions: ['read', 'write'],
        },
      } satisfies TokenResponse
    },
  }
}

/**
 * Token vendor with a caller-controlled TTL and a spy-friendly call
 * counter. Each `fetch()` returns a distinct token string
 * (`token-1`, `token-2`, …) so tests can assert the state machine
 * observed a new value.
 */
export function refreshingTokenVendor(ttlMs: number): TokenVendor & {
  callCount: () => number
  tokens: () => string[]
} {
  const tokens: string[] = []
  return {
    async fetch() {
      const token = `token-${tokens.length + 1}`
      tokens.push(token)
      return {
        token,
        expiresAt: new Date(Date.now() + ttlMs),
        scopeClaims: {
          brand: 'ziva',
          tenantScope: 'family',
          tenantId: 'fam_test',
          permissions: ['read', 'write'],
        },
      }
    },
    callCount: () => tokens.length,
    tokens: () => [...tokens],
  }
}

/**
 * Compose an `AnalyticsConfig` wired to the MinIO + REST stack. Caller
 * still needs to invoke `attach()` on the resulting engine.
 *
 * The default `warehouseUriBuilder` returns the REST warehouse name so
 * `ATTACH '<name>' (TYPE ICEBERG)` resolves against the SECRET's ENDPOINT
 * (compare with the production builder which returns the full R2 URI).
 */
export function testAnalyticsConfig(
  ep: Endpoints,
  overrides: Partial<AnalyticsConfig> = {},
): AnalyticsConfig {
  return {
    storage: memoryKV(),
    warehouseUriBuilder: () => ep.warehouseName,
    catalogEndpoint: ep.restEndpoint,
    tokenVendor: staticTokenVendor(),
    familyMembersProvider: async () => [],
    retention: {},
    ...overrides,
  }
}

// -------------------- Row-level seeding --------------------

/**
 * Push `n` synthetic hrv-like rows into `table` via the sync appender.
 * `startTs` is the timestamp of the first row; subsequent rows step
 * forward by one minute so `ORDER BY ts` is deterministic.
 *
 * The row shape matches the fixed 4-column schema
 * `(user_id VARCHAR, device_id VARCHAR, ts TIMESTAMP, value DOUBLE)`
 * used by the test suite. Callers create the table separately with
 * either an iceberg `CREATE TABLE` or a local `CREATE TABLE` — this
 * helper only appends.
 */
export function seedHrvRows(
  db: DuckDBInstance,
  table: string,
  n: number,
  startTs: Date,
  userId = 'u1',
  deviceId = 'd1',
): void {
  const app = db.createAppender(table)
  try {
    for (let i = 0; i < n; i++) {
      const ts = new Date(startTs.getTime() + i * 60_000)
      app.appendRow([userId, deviceId, ts, 50 + i])
    }
    app.flush()
  }
  finally {
    app.close()
  }
}

/**
 * Seed `n` sleep_session rows starting at `startTs` (one session per day,
 * 7h sleep window). Column order matches the 14-column schema at
 * `schemas.ts:101-116`.
 *
 * `ts_start` is the sync watermark column (`timeColumnFor('sleep_session')`);
 * `ts_end` is the retention column (`TABLE_RETENTION.sleep_session.tsColumn`).
 * Both step forward one day per row so ORDER BY either is deterministic.
 */
export interface SleepSessionSeedOpts {
  userId?: string
  deviceId?: string
  familyId?: string
  brand?: string
  sessionPrefix?: string
  /** Milliseconds between successive sessions' `ts_start`. Default 24h. */
  stepMs?: number
  /** Length of each session in ms. Default 7h. */
  sessionMs?: number
}

export function seedSleepSessionRows(
  db: DuckDBInstance,
  table: string,
  n: number,
  startTs: Date,
  opts: SleepSessionSeedOpts = {},
): void {
  const brand = opts.brand ?? 'ziva'
  const familyId = opts.familyId ?? 'fam_int'
  const userId = opts.userId ?? 'user_int'
  const deviceId = opts.deviceId ?? 'ring_int'
  const prefix = opts.sessionPrefix ?? 'sess'
  const stepMs = opts.stepMs ?? 24 * 60 * 60 * 1000
  const sessionMs = opts.sessionMs ?? 7 * 60 * 60 * 1000

  const app = db.createAppender(table)
  try {
    for (let i = 0; i < n; i++) {
      const start = new Date(startTs.getTime() + i * stepMs)
      const end = new Date(start.getTime() + sessionMs)
      const nightOf = new Date(Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth(),
        start.getUTCDate(),
      ))
      app.appendRow([
        `${prefix}_${i}`, // session_id
        start, // ts_start
        end, // ts_end
        brand, // brand
        familyId, // family_id
        userId, // user_id
        deviceId, // device_id
        420, // total_minutes
        90, // deep_minutes
        80, // rem_minutes
        180, // light_minutes
        70, // awake_minutes
        0.92, // avg_confidence
        nightOf, // night_of (DATE)
      ])
    }
    app.flush()
  }
  finally {
    app.close()
  }
}

/**
 * Seed `n` device_config rows starting at `validFromStart`. Column order
 * matches the 11-column schema at `schemas.ts:150-163`.
 *
 * Composite PK `(device_id, metric, valid_from)` requires distinct
 * `metric` values across rows (default: `metric_0`, `metric_1`, …).
 * `valid_to` is emitted as `null` by default (open/current config) so
 * NULL round-trip through Iceberg can be asserted.
 */
export interface DeviceConfigSeedOpts {
  userId?: string
  deviceId?: string
  familyId?: string
  brand?: string
  /** Metric-name prefix; suffixed per row to satisfy the composite PK. */
  metricPrefix?: string
  intervalMinutes?: number
  startTime?: string | null
  endTime?: string | null
  weeks?: number | null
  /** Milliseconds between successive rows' `valid_from`. Default 1h. */
  stepMs?: number
  /** Optional `valid_to` — omit for `null` (open config). */
  validTo?: Date | null
}

export function seedDeviceConfigRows(
  db: DuckDBInstance,
  table: string,
  n: number,
  validFromStart: Date,
  opts: DeviceConfigSeedOpts = {},
): void {
  const brand = opts.brand ?? 'ziva'
  const familyId = opts.familyId ?? 'fam_int'
  const userId = opts.userId ?? 'user_int'
  const deviceId = opts.deviceId ?? 'ring_int'
  const metricPrefix = opts.metricPrefix ?? 'metric'
  const intervalMinutes = opts.intervalMinutes ?? 15
  const startTime = opts.startTime ?? null
  const endTime = opts.endTime ?? null
  const weeks = opts.weeks ?? null
  const stepMs = opts.stepMs ?? 60 * 60 * 1000
  const validTo = opts.validTo === undefined ? null : opts.validTo

  const app = db.createAppender(table)
  try {
    for (let i = 0; i < n; i++) {
      const validFrom = new Date(validFromStart.getTime() + i * stepMs)
      app.appendRow([
        deviceId, // device_id
        brand, // brand
        familyId, // family_id
        userId, // user_id
        `${metricPrefix}_${i}`, // metric (composite-PK component)
        intervalMinutes, // interval_minutes
        startTime, // start_time (nullable)
        endTime, // end_time (nullable)
        weeks, // weeks (nullable)
        validFrom, // valid_from
        validTo, // valid_to (nullable — SCD-2 open flag)
      ])
    }
    app.flush()
  }
  finally {
    app.close()
  }
}
