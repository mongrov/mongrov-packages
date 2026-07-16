/**
 * T-28 — R2 push → fetch byte-equal round trip against MinIO + Iceberg REST.
 *
 * Companion suite to `src/core/__tests__/minio.integration.test.ts`. Uses
 * the same docker-compose stack under `packages/analytics/infra/analytics-minio/`;
 * the shared Vitest globalSetup (`src/__integration__/setup/global-setup.ts`)
 * boots the stack once for the whole run.
 *
 * Round-trip contract:
 *   1. Engine A attaches, seeds N local rows, `R2Pusher.push()` copies them
 *      into the Iceberg warehouse.
 *   2. Verify local ≡ iceberg via symmetric-difference SQL (EXCEPT ⋃ EXCEPT).
 *   3. Engine B (a *fresh* factory / new DuckDB process-level state) attaches
 *      the SAME warehouse, `R2Fetcher.fetchIncremental()` pulls back into a
 *      fresh empty local table.
 *   4. Verify engine-B's local table ≡ iceberg — byte-equal round trip proven.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { HybridDuckDB } from '../../core/engine'
import type { AnalyticsEngine, AttachContext } from '../../core/types'
import { createAnalytics } from '../../core/factory'
import { warehouseSecretName } from '../../core/warehouse'
import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { endpoints, type Endpoints } from '../../__integration__/setup/endpoints'
import {
  dropNamespace,
  ensureNamespace,
  ensureS3Secret,
  memoryKV,
  staticTokenVendor,
} from '../../__integration__/setup/seed'
import { R2Fetcher } from '../fetcher'
import { R2Pusher } from '../pusher'
import { WatermarkStore } from '../watermark'

const NAMESPACE = 'default'
const TENANT = 'fam_sync'
const CATALOG = warehouseSecretName(TENANT) // `zone_fam_sync`
const TABLE = 'hrv'
const LOCAL_QUALIFIED = `memory.main.${TABLE}`
const REMOTE_QUALIFIED = `${CATALOG}.${NAMESPACE}.${TABLE}`

function ctx(): AttachContext {
  return { brand: 'ziva', tenantScope: 'family', tenantId: TENANT, userId: 'u1' }
}

function bootEngine(): AnalyticsEngine {
  return createAnalytics(
    {
      storage: memoryKV(),
      warehouseUriBuilder: () => globalThis.__INTEGRATION_EP__.warehouseName,
      catalogEndpoint: globalThis.__INTEGRATION_EP__.restEndpoint,
      tokenVendor: staticTokenVendor(),
      familyMembersProvider: async () => [],
      retention: {},
    },
    {
      duckdbFactory: async () => {
        const inst = await createRealDuckDB()
        await ensureS3Secret(inst, globalThis.__INTEGRATION_EP__)
        return inst
      },
    },
  )
}

declare global {
  // eslint-disable-next-line no-var
  var __INTEGRATION_EP__: Endpoints
}

/**
 * Adapt an `AnalyticsEngine` to the `HybridDuckDB` shape the sync classes
 * expect. The pusher/fetcher only ever call `execute()`, so a thin passthrough
 * is enough; the cast quiets TS on the fields (`open`, `close`, private
 * `#inst`) that neither class touches.
 */
function asDuckDBLike(engine: AnalyticsEngine): HybridDuckDB {
  return {
    execute: (sql, params) => engine.execute(sql, params),
  } as unknown as HybridDuckDB
}

/**
 * Create `memory.main.<table>` with the exact column shape of the Iceberg
 * hrv table. A PRIMARY KEY is required so the fetcher's `ON CONFLICT DO
 * NOTHING` can bind — DuckDB rejects it otherwise. The Iceberg hrv table
 * itself has no PK, but for the local cache mirror we synthesise one on
 * `(ts, user_id, device_id)`; those three uniquely identify a sensor reading.
 */
async function ensureLocalMirror(engine: AnalyticsEngine): Promise<void> {
  await engine.execute(
    `CREATE TABLE IF NOT EXISTS ${LOCAL_QUALIFIED} (
      ts TIMESTAMP NOT NULL,
      brand VARCHAR NOT NULL,
      family_id VARCHAR NOT NULL,
      user_id VARCHAR NOT NULL,
      device_id VARCHAR NOT NULL,
      hrv_ms INTEGER,
      stress INTEGER,
      systolic_bp INTEGER,
      diastolic_bp INTEGER,
      vascular_aging INTEGER,
      PRIMARY KEY (ts, user_id, device_id)
    )`,
  )
  await engine.execute(`DELETE FROM ${LOCAL_QUALIFIED}`)
}

/**
 * Cleanup for iterative reruns against the persistent MinIO volume.
 */
async function resetRemote(engine: AnalyticsEngine): Promise<void> {
  await engine.execute(
    `DELETE FROM ${REMOTE_QUALIFIED} WHERE family_id = $f`,
    { f: TENANT },
  )
}

/**
 * Insert `n` deterministic rows into the local mirror; timestamps step by
 * one minute so ORDER BY ts is stable across pushes and fetches.
 */
async function seedLocal(engine: AnalyticsEngine, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const ts = new Date(Date.UTC(2025, 5, 1, 0, i, 0))
      .toISOString().replace('T', ' ').replace('Z', '')
    await engine.execute(
      `INSERT INTO ${LOCAL_QUALIFIED}
         (ts, brand, family_id, user_id, device_id, hrv_ms)
         VALUES ($ts::TIMESTAMP, 'ziva', $f, 'u1', 'd1', $v)`,
      { ts, f: TENANT, v: 60 + i },
    )
  }
}

/**
 * Symmetric-difference cardinality. Returns 0 iff the two projections are
 * multiset-equal (byte-equal ignoring row order, which is what "byte-equal
 * round trip" means when Iceberg re-serialises).
 */
async function symmetricDiff(
  engine: AnalyticsEngine,
  a: string,
  b: string,
): Promise<bigint> {
  const rows = await engine.execute<{ n: bigint }>(
    `SELECT COUNT(*)::BIGINT AS n FROM (
       (SELECT * FROM ${a} WHERE family_id = $f
          EXCEPT
        SELECT * FROM ${b} WHERE family_id = $f)
       UNION ALL
       (SELECT * FROM ${b} WHERE family_id = $f
          EXCEPT
        SELECT * FROM ${a} WHERE family_id = $f)
     )`,
    { f: TENANT },
  )
  return rows[0]?.n ?? 0n
}

// -------------------- sleep_session helpers --------------------

const SLEEP_TABLE = 'sleep_session'
const SLEEP_LOCAL = `memory.main.${SLEEP_TABLE}`
const SLEEP_REMOTE = `${CATALOG}.${NAMESPACE}.${SLEEP_TABLE}`

/**
 * `memory.main.sleep_session` local mirror. PK matches the Iceberg schema
 * (single-column `session_id`) so the fetcher's ON CONFLICT DO NOTHING binds.
 * 14 columns — matches `schemas.ts:101-116`.
 */
async function ensureSleepMirror(engine: AnalyticsEngine): Promise<void> {
  await engine.execute(
    `CREATE TABLE IF NOT EXISTS ${SLEEP_LOCAL} (
      session_id VARCHAR PRIMARY KEY,
      ts_start TIMESTAMP NOT NULL,
      ts_end TIMESTAMP NOT NULL,
      brand VARCHAR NOT NULL,
      family_id VARCHAR NOT NULL,
      user_id VARCHAR NOT NULL,
      device_id VARCHAR NOT NULL,
      total_minutes INTEGER NOT NULL,
      deep_minutes INTEGER,
      rem_minutes INTEGER,
      light_minutes INTEGER,
      awake_minutes INTEGER,
      avg_confidence DOUBLE,
      night_of DATE
    )`,
  )
  await engine.execute(`DELETE FROM ${SLEEP_LOCAL}`)
}

async function resetRemoteSleep(engine: AnalyticsEngine): Promise<void> {
  await engine.execute(
    `DELETE FROM ${SLEEP_REMOTE} WHERE family_id = $f`,
    { f: TENANT },
  )
}

async function seedLocalSleep(engine: AnalyticsEngine, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const start = new Date(Date.UTC(2025, 5, 1 + i, 22, 0, 0))
      .toISOString().replace('T', ' ').replace('Z', '')
    const end = new Date(Date.UTC(2025, 5, 2 + i, 5, 0, 0))
      .toISOString().replace('T', ' ').replace('Z', '')
    const nightOf = `2025-06-${String(1 + i).padStart(2, '0')}`
    await engine.execute(
      `INSERT INTO ${SLEEP_LOCAL}
         (session_id, ts_start, ts_end, brand, family_id, user_id, device_id,
          total_minutes, deep_minutes, rem_minutes, light_minutes,
          awake_minutes, avg_confidence, night_of)
         VALUES ($sid, $s::TIMESTAMP, $e::TIMESTAMP, 'ziva', $f, 'u1', 'd1',
                 420, 90, 80, 180, 70, 0.92, $night::DATE)`,
      { sid: `sess_${i}`, s: start, e: end, f: TENANT, night: nightOf },
    )
  }
}

// -------------------- device_config helpers --------------------

const CONFIG_TABLE = 'device_config'
const CONFIG_LOCAL = `memory.main.${CONFIG_TABLE}`
const CONFIG_REMOTE = `${CATALOG}.${NAMESPACE}.${CONFIG_TABLE}`

/**
 * `memory.main.device_config` local mirror. Composite PK matches the Iceberg
 * schema (`device_id, data_type, valid_from`) so ON CONFLICT DO NOTHING is
 * bound correctly — critical for the "fetch twice, count stable" idempotency
 * assertion in the round-trip test.
 */
async function ensureConfigMirror(engine: AnalyticsEngine): Promise<void> {
  await engine.execute(
    `CREATE TABLE IF NOT EXISTS ${CONFIG_LOCAL} (
      device_id VARCHAR NOT NULL,
      brand VARCHAR NOT NULL,
      family_id VARCHAR NOT NULL,
      user_id VARCHAR NOT NULL,
      data_type INTEGER NOT NULL,
      interval_minutes INTEGER NOT NULL,
      start_time VARCHAR,
      end_time VARCHAR,
      weeks INTEGER,
      valid_from TIMESTAMP NOT NULL,
      valid_to TIMESTAMP,
      PRIMARY KEY (device_id, data_type, valid_from)
    )`,
  )
  await engine.execute(`DELETE FROM ${CONFIG_LOCAL}`)
}

async function resetRemoteConfig(engine: AnalyticsEngine): Promise<void> {
  await engine.execute(
    `DELETE FROM ${CONFIG_REMOTE} WHERE family_id = $f`,
    { f: TENANT },
  )
}

/**
 * Seed `n` device_config rows. Distinct `data_type` values (composite-PK
 * requirement) and all rows are open configs (`valid_to = NULL`) so the
 * round-trip must preserve NULL.
 */
async function seedLocalConfig(engine: AnalyticsEngine, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const validFrom = new Date(Date.UTC(2025, 5, 1, i, 0, 0))
      .toISOString().replace('T', ' ').replace('Z', '')
    await engine.execute(
      `INSERT INTO ${CONFIG_LOCAL}
         (device_id, brand, family_id, user_id, data_type,
          interval_minutes, start_time, end_time, weeks,
          valid_from, valid_to)
         VALUES ('d1', 'ziva', $f, 'u1', $dt,
                 15, NULL, NULL, NULL,
                 $vf::TIMESTAMP, NULL)`,
      { f: TENANT, dt: 300 + i, vf: validFrom },
    )
  }
}

describe('T-28 — R2 push/fetch byte-equal round trip (MinIO)', () => {
  let ep: Endpoints

  beforeAll(async () => {
    ep = endpoints()
    // Publish for `bootEngine()` — avoids threading `ep` through every helper.
    globalThis.__INTEGRATION_EP__ = ep
    await ensureNamespace(ep.restEndpoint, NAMESPACE)
  })

  afterAll(async () => {
    await dropNamespace(ep.restEndpoint, NAMESPACE).catch(() => {})
  })

  it('push writes local rows into the Iceberg zone; fetch pulls them back into a fresh engine — byte-equal both ways', async () => {
    const ROW_COUNT = 50
    const push = bootEngine()
    let pushLocalSnapshot: readonly Record<string, unknown>[] = []

    try {
      await push.attach(ctx())
      expect(push.state).toBe('attached')

      await ensureLocalMirror(push)
      await resetRemote(push)

      await seedLocal(push, ROW_COUNT)
      const localCount = await push.execute<{ n: bigint }>(
        `SELECT COUNT(*)::BIGINT AS n FROM ${LOCAL_QUALIFIED}`,
      )
      expect(localCount[0]?.n).toBe(BigInt(ROW_COUNT))

      // Capture the seed for a later engine-B comparison (bypass the
      // iceberg round trip so we can prove the *end-to-end* equality
      // separately from the local-vs-iceberg step).
      pushLocalSnapshot = await push.execute(
        `SELECT * FROM ${LOCAL_QUALIFIED} ORDER BY ts`,
      )
      expect(pushLocalSnapshot).toHaveLength(ROW_COUNT)

      const kv = memoryKV()
      const wm = new WatermarkStore({
        kv,
        // Seed rows use a fixed 2025-06-01 timestamp so ordering is
        // deterministic; widen the fresh-install horizon so they're inside
        // the "> watermark" filter no matter when the test runs.
        defaultRetentionMs: 365 * 10 * 24 * 60 * 60 * 1000, // 10y
      })
      const pusher = new R2Pusher({
        engine: asDuckDBLike(push),
        watermark: wm,
        // After `USE <catalog>.default`, DuckDB resolves 2-part names inside
        // the iceberg catalog, so the pusher's default `main.<t>` local
        // resolver misses. Force the fully-qualified in-memory path.
        localTable: (_c, t) => `memory.main.${t}`,
        remoteTable: (_c, t) => `${CATALOG}.${NAMESPACE}.${t}`,
      })

      const pushResult = await pusher.push(TABLE, ctx())
      expect(pushResult).toMatchObject({ table: TABLE, ok: true })
      expect(pushResult.rowsPushed).toBe(ROW_COUNT)

      // Local ≡ iceberg after push.
      expect(await symmetricDiff(push, LOCAL_QUALIFIED, REMOTE_QUALIFIED)).toBe(0n)

      // Watermark advanced to the max ts we pushed.
      const advanced = await wm.get('ziva', TENANT, TABLE, 'push')
      expect(advanced.getTime()).toBeGreaterThan(0)

      await push.detach()
    }
    finally {
      await push.close()
    }

    // -------- fresh engine — fetch side --------

    const fetch = bootEngine()
    try {
      await fetch.attach(ctx())
      expect(fetch.state).toBe('attached')

      await ensureLocalMirror(fetch) // guaranteed empty (DELETE inside helper)

      // Fresh KV → watermark defaults to now - 30d, so the seed (dated
      // 2025-06-01) is inside the window. NOTE: if the seed ever slides
      // outside the 30-day default, use `defaultRetentionMs` to widen it.
      const kv = memoryKV()
      const wm = new WatermarkStore({
        kv,
        defaultRetentionMs: 365 * 10 * 24 * 60 * 60 * 1000, // 10y — future-proof
      })
      const fetcher = new R2Fetcher({
        engine: asDuckDBLike(fetch),
        watermark: wm,
        tables: [TABLE],
        localTable: (_c, t) => `memory.main.${t}`,
        remoteTable: (_c, t) => `${CATALOG}.${NAMESPACE}.${t}`,
      })

      const fetchResults = await fetcher.fetchIncremental(ctx())
      expect(fetchResults).toHaveLength(1)
      expect(fetchResults[0]).toMatchObject({ table: TABLE, ok: true })
      expect(fetchResults[0]?.rowsFetched).toBe(ROW_COUNT)

      // Fresh local ≡ iceberg.
      expect(await symmetricDiff(fetch, LOCAL_QUALIFIED, REMOTE_QUALIFIED)).toBe(0n)

      // End-to-end byte-equal proof: engine-B's local ≡ engine-A's original
      // local seed. Compare on a projection to normalise BigInt/Date shapes.
      const fetchLocalSnapshot = await fetch.execute(
        `SELECT * FROM ${LOCAL_QUALIFIED} ORDER BY ts`,
      )
      expect(fetchLocalSnapshot).toHaveLength(ROW_COUNT)
      expect(fetchLocalSnapshot).toEqual(pushLocalSnapshot)

      await fetch.detach()
    }
    finally {
      await fetch.close()
    }
  }, 30_000)

  it('sleep_session — push/fetch byte-equal round trip (ts_start watermark, DATE round-trip)', async () => {
    const ROW_COUNT = 10
    const push = bootEngine()
    let pushLocalSnapshot: readonly Record<string, unknown>[] = []

    try {
      await push.attach(ctx())
      await ensureSleepMirror(push)
      await resetRemoteSleep(push)
      await seedLocalSleep(push, ROW_COUNT)

      pushLocalSnapshot = await push.execute(
        `SELECT * FROM ${SLEEP_LOCAL} ORDER BY ts_start`,
      )
      expect(pushLocalSnapshot).toHaveLength(ROW_COUNT)

      const wm = new WatermarkStore({
        kv: memoryKV(),
        defaultRetentionMs: 365 * 10 * 24 * 60 * 60 * 1000, // 10y
      })
      const pusher = new R2Pusher({
        engine: asDuckDBLike(push),
        watermark: wm,
        localTable: (_c, t) => `memory.main.${t}`,
        remoteTable: (_c, t) => `${CATALOG}.${NAMESPACE}.${t}`,
      })

      // R2Pusher.push('sleep_session', …) will resolve `timeColumnFor` →
      // 'ts_start' and issue `WHERE ts_start > $watermark`. If the refactor
      // regresses and hardcodes 'ts', the SELECT will fail here.
      const pushResult = await pusher.push(SLEEP_TABLE, ctx())
      expect(pushResult).toMatchObject({ table: SLEEP_TABLE, ok: true })
      expect(pushResult.rowsPushed).toBe(ROW_COUNT)
      expect(await symmetricDiff(push, SLEEP_LOCAL, SLEEP_REMOTE)).toBe(0n)

      await push.detach()
    }
    finally {
      await push.close()
    }

    const fetch = bootEngine()
    try {
      await fetch.attach(ctx())
      await ensureSleepMirror(fetch)

      const wm = new WatermarkStore({
        kv: memoryKV(),
        defaultRetentionMs: 365 * 10 * 24 * 60 * 60 * 1000,
      })
      const fetcher = new R2Fetcher({
        engine: asDuckDBLike(fetch),
        watermark: wm,
        tables: [SLEEP_TABLE],
        localTable: (_c, t) => `memory.main.${t}`,
        remoteTable: (_c, t) => `${CATALOG}.${NAMESPACE}.${t}`,
      })

      const fetchResults = await fetcher.fetchIncremental(ctx())
      expect(fetchResults).toHaveLength(1)
      expect(fetchResults[0]).toMatchObject({ table: SLEEP_TABLE, ok: true })
      expect(fetchResults[0]?.rowsFetched).toBe(ROW_COUNT)
      expect(await symmetricDiff(fetch, SLEEP_LOCAL, SLEEP_REMOTE)).toBe(0n)

      const fetchLocalSnapshot = await fetch.execute(
        `SELECT * FROM ${SLEEP_LOCAL} ORDER BY ts_start`,
      )
      expect(fetchLocalSnapshot).toHaveLength(ROW_COUNT)
      expect(fetchLocalSnapshot).toEqual(pushLocalSnapshot)

      await fetch.detach()
    }
    finally {
      await fetch.close()
    }
  }, 30_000)

  it('device_config — push/fetch byte-equal round trip (composite PK, NULL preservation, idempotent re-fetch)', async () => {
    const ROW_COUNT = 3
    const push = bootEngine()
    let pushLocalSnapshot: readonly Record<string, unknown>[] = []

    try {
      await push.attach(ctx())
      await ensureConfigMirror(push)
      await resetRemoteConfig(push)
      await seedLocalConfig(push, ROW_COUNT)

      pushLocalSnapshot = await push.execute(
        `SELECT * FROM ${CONFIG_LOCAL} ORDER BY valid_from, data_type`,
      )
      expect(pushLocalSnapshot).toHaveLength(ROW_COUNT)

      const wm = new WatermarkStore({
        kv: memoryKV(),
        defaultRetentionMs: 365 * 10 * 24 * 60 * 60 * 1000,
      })
      const pusher = new R2Pusher({
        engine: asDuckDBLike(push),
        watermark: wm,
        localTable: (_c, t) => `memory.main.${t}`,
        remoteTable: (_c, t) => `${CATALOG}.${NAMESPACE}.${t}`,
      })

      // R2Pusher uses timeColumnFor('device_config') → 'valid_from'.
      const pushResult = await pusher.push(CONFIG_TABLE, ctx())
      expect(pushResult).toMatchObject({ table: CONFIG_TABLE, ok: true })
      expect(pushResult.rowsPushed).toBe(ROW_COUNT)
      expect(await symmetricDiff(push, CONFIG_LOCAL, CONFIG_REMOTE)).toBe(0n)

      // NULL valid_to survived the push.
      const nulls = await push.execute<{ n: bigint }>(
        `SELECT COUNT(*)::BIGINT AS n FROM ${CONFIG_REMOTE}
          WHERE family_id = $f AND valid_to IS NULL`,
        { f: TENANT },
      )
      expect(nulls[0]?.n).toBe(BigInt(ROW_COUNT))

      await push.detach()
    }
    finally {
      await push.close()
    }

    const fetch = bootEngine()
    try {
      await fetch.attach(ctx())
      await ensureConfigMirror(fetch)

      const wm = new WatermarkStore({
        kv: memoryKV(),
        defaultRetentionMs: 365 * 10 * 24 * 60 * 60 * 1000,
      })
      const fetcher = new R2Fetcher({
        engine: asDuckDBLike(fetch),
        watermark: wm,
        tables: [CONFIG_TABLE],
        localTable: (_c, t) => `memory.main.${t}`,
        remoteTable: (_c, t) => `${CATALOG}.${NAMESPACE}.${t}`,
      })

      const first = await fetcher.fetchIncremental(ctx())
      expect(first[0]?.rowsFetched).toBe(ROW_COUNT)
      expect(await symmetricDiff(fetch, CONFIG_LOCAL, CONFIG_REMOTE)).toBe(0n)

      // Idempotency: composite-PK ON CONFLICT DO NOTHING holds count stable
      // on a re-fetch even without watermark advance (defensive re-run).
      const firstCount = await fetch.execute<{ n: bigint }>(
        `SELECT COUNT(*)::BIGINT AS n FROM ${CONFIG_LOCAL}`,
      )
      // Force a re-fetch by resetting the local watermark; the ON CONFLICT
      // clause on the local mirror is what prevents duplication.
      const wm2 = new WatermarkStore({
        kv: memoryKV(),
        defaultRetentionMs: 365 * 10 * 24 * 60 * 60 * 1000,
      })
      const fetcher2 = new R2Fetcher({
        engine: asDuckDBLike(fetch),
        watermark: wm2,
        tables: [CONFIG_TABLE],
        localTable: (_c, t) => `memory.main.${t}`,
        remoteTable: (_c, t) => `${CATALOG}.${NAMESPACE}.${t}`,
      })
      await fetcher2.fetchIncremental(ctx())
      const secondCount = await fetch.execute<{ n: bigint }>(
        `SELECT COUNT(*)::BIGINT AS n FROM ${CONFIG_LOCAL}`,
      )
      expect(secondCount[0]?.n).toBe(firstCount[0]?.n)

      const fetchLocalSnapshot = await fetch.execute(
        `SELECT * FROM ${CONFIG_LOCAL} ORDER BY valid_from, data_type`,
      )
      expect(fetchLocalSnapshot).toHaveLength(ROW_COUNT)
      expect(fetchLocalSnapshot).toEqual(pushLocalSnapshot)

      await fetch.detach()
    }
    finally {
      await fetch.close()
    }
  }, 30_000)
})
