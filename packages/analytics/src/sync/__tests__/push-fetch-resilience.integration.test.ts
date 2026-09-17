/**
 * R2 push/fetch resilience against MinIO + Iceberg REST (zivaone_app#53).
 *
 * `push-fetch.integration.test.ts` proves a byte-equal round trip once. #53
 * asks what happens on the SECOND and later cycles, which is where a sync
 * layer actually lives:
 *
 *   - incremental fetch returns only rows pushed since the last fetch;
 *   - all-family prefetch brings every member's rows, and no other family's;
 *   - a 401 mid-push refreshes the token and still lands the rows;
 *   - re-pushing with nothing new writes nothing.
 *
 * Plus two cases the fake-engine unit tests cannot see, because both depend
 * on what is really in the remote table — recorded with `it.fails` so the
 * suite stays green while the defect stands and turns red the day it is
 * fixed (see the note on each).
 */

import type { Endpoints } from '../../__integration__/setup/endpoints'
import type { HybridDuckDB } from '../../core/engine'
import type { AnalyticsEngine, AttachContext, KVStore } from '../../core/types'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { endpoints } from '../../__integration__/setup/endpoints'
import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import {
  ensureNamespace,
  ensureS3Secret,
  memoryKV,
  staticTokenVendor,
} from '../../__integration__/setup/seed'
import { createAnalytics } from '../../core/factory'
import { warehouseSecretName } from '../../core/warehouse'
import { R2Fetcher } from '../fetcher'
import { R2Pusher } from '../pusher'
import { WatermarkStore } from '../watermark'

const NAMESPACE = 'default'
const TENANT = 'fam_resil'
const CATALOG = warehouseSecretName(TENANT)
const TABLE = 'hrv'
const LOCAL = `memory.main.${TABLE}`
const REMOTE = `${CATALOG}.${NAMESPACE}.${TABLE}`
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000

let ep: Endpoints

function ctx(userId = 'u1'): AttachContext {
  return { brand: 'ziva', tenantScope: 'family', tenantId: TENANT, userId }
}

function bootEngine(): AnalyticsEngine {
  return createAnalytics(
    {
      storage: memoryKV(),
      warehouseUriBuilder: () => ep.warehouseName,
      catalogEndpoint: ep.restEndpoint,
      tokenVendor: staticTokenVendor(),
      familyMembersProvider: async () => [],
      retention: {},
    },
    {
      duckdbFactory: async () => {
        const inst = await createRealDuckDB()
        await ensureS3Secret(inst, ep)
        return inst
      },
    },
  )
}

function asDuckDBLike(engine: AnalyticsEngine): HybridDuckDB {
  return { execute: (sql, params) => engine.execute(sql, params) } as unknown as HybridDuckDB
}

async function ensureLocal(engine: AnalyticsEngine): Promise<void> {
  await engine.execute(
    `CREATE TABLE IF NOT EXISTS ${LOCAL} (
      ts TIMESTAMP NOT NULL, brand VARCHAR NOT NULL, family_id VARCHAR NOT NULL,
      user_id VARCHAR NOT NULL, device_id VARCHAR NOT NULL, hrv_ms INTEGER,
      stress INTEGER, systolic_bp INTEGER, diastolic_bp INTEGER, vascular_aging INTEGER,
      PRIMARY KEY (ts, user_id, device_id)
    )`,
  )
  await engine.execute(`DELETE FROM ${LOCAL}`)
}

/** `n` rows starting `startMin` minutes into 2025-06-01, for `family`/`user`. */
async function seed(
  engine: AnalyticsEngine,
  target: string,
  { n, startMin = 0, user = 'u1', family = TENANT, at }: { n: number, startMin?: number, user?: string, family?: string, at?: (i: number) => Date },
): Promise<void> {
  for (let i = 0; i < n; i++) {
    const when = at ? at(i) : new Date(Date.UTC(2025, 5, 1, 0, startMin + i, 0))
    await engine.execute(
      `INSERT INTO ${target} (ts, brand, family_id, user_id, device_id, hrv_ms)
       VALUES ($ts::TIMESTAMP, 'ziva', $f, $u, 'd1', $v)`,
      { ts: when.toISOString().replace('T', ' ').replace('Z', ''), f: family, u: user, v: 40 + (i % 30) },
    )
  }
}

async function count(engine: AnalyticsEngine, table: string, where = 'family_id = $f'): Promise<number> {
  const rows = await engine.execute<{ n: bigint }>(`SELECT COUNT(*)::BIGINT AS n FROM ${table} WHERE ${where}`, { f: TENANT })
  return Number(rows[0]?.n ?? 0)
}

function names() {
  return { localTable: () => LOCAL, remoteTable: () => REMOTE }
}

function pusherFor(engine: AnalyticsEngine, kv: KVStore, extra: Partial<ConstructorParameters<typeof R2Pusher>[0]> = {}) {
  return new R2Pusher({
    engine: asDuckDBLike(engine),
    watermark: new WatermarkStore({ kv, defaultRetentionMs: TEN_YEARS_MS }),
    ...names(),
    ...extra,
  })
}

function fetcherFor(engine: AnalyticsEngine, kv: KVStore) {
  return new R2Fetcher({
    engine: asDuckDBLike(engine),
    watermark: new WatermarkStore({ kv, defaultRetentionMs: TEN_YEARS_MS }),
    tables: [TABLE],
    ...names(),
  })
}

/** Two attached engines — a pushing device and a fetching one — over one warehouse. */
async function twoDevices<T>(run: (a: AnalyticsEngine, b: AnalyticsEngine) => Promise<T>): Promise<T> {
  const a = bootEngine()
  const b = bootEngine()
  try {
    await a.attach(ctx())
    await b.attach(ctx())
    await ensureLocal(a)
    await ensureLocal(b)
    await a.execute(`DELETE FROM ${REMOTE} WHERE family_id IN ($f, 'fam_other')`, { f: TENANT })
    return await run(a, b)
  }
  finally {
    await a.close()
    await b.close()
  }
}

describe('R2 push/fetch resilience (MinIO, zivaone_app#53)', () => {
  beforeAll(async () => {
    ep = endpoints()
    await ensureNamespace(ep.restEndpoint, NAMESPACE)
  })

  afterAll(async () => {
    // Namespace is shared with push-fetch.integration.test.ts, which drops it.
  })

  it('incremental fetch returns only rows pushed since the last fetch', async () => {
    await twoDevices(async (a, b) => {
      const pushKv = memoryKV()
      const fetchKv = memoryKV()
      await seed(a, LOCAL, { n: 30 })
      expect((await pusherFor(a, pushKv).push(TABLE, ctx())).rowsPushed).toBe(30)

      const first = await fetcherFor(b, fetchKv).fetchIncremental(ctx())
      expect(first[0]).toMatchObject({ ok: true, rowsFetched: 30 })

      await seed(a, LOCAL, { n: 12, startMin: 30 }) // strictly newer
      expect((await pusherFor(a, pushKv).push(TABLE, ctx())).rowsPushed).toBe(12)

      const second = await fetcherFor(b, fetchKv).fetchIncremental(ctx())
      expect(second[0]).toMatchObject({ ok: true, rowsFetched: 12 })
      expect(await count(b, LOCAL)).toBe(42)
    })
  }, 120_000)

  it('re-pushing with nothing new writes nothing', async () => {
    await twoDevices(async (a) => {
      const kv = memoryKV()
      await seed(a, LOCAL, { n: 20 })
      await pusherFor(a, kv).push(TABLE, ctx())
      const again = await pusherFor(a, kv).push(TABLE, ctx())
      expect(again).toMatchObject({ ok: true, rowsPushed: 0 })
      expect(await count(a, REMOTE)).toBe(20)
    })
  }, 120_000)

  it('all-family prefetch brings every member\'s rows within the window, and no other family\'s', async () => {
    await twoDevices(async (a, b) => {
      const recent = (i: number) => new Date(Date.now() - (2 * 24 * 60 - i) * 60 * 1000)
      const stale = (i: number) => new Date(Date.now() - (60 * 24 * 60 - i) * 60 * 1000)
      await seed(a, REMOTE, { n: 5, user: 'u1', at: recent })
      await seed(a, REMOTE, { n: 7, user: 'u2', at: i => recent(i + 100) })
      await seed(a, REMOTE, { n: 4, user: 'u1', at: stale }) // outside a 30-day window
      await seed(a, REMOTE, { n: 6, user: 'x9', family: 'fam_other', at: recent })

      const results = await fetcherFor(b, memoryKV()).prefetchOnAttach(ctx(), { kind: 'all-family-on-attach', windowDays: 30 })
      expect(results[0]).toMatchObject({ ok: true })

      expect(await count(b, LOCAL, `family_id = $f AND user_id = 'u1'`)).toBe(5)
      expect(await count(b, LOCAL, `family_id = $f AND user_id = 'u2'`)).toBe(7)
      expect(await count(b, LOCAL, `family_id <> $f`)).toBe(0)
    })
  }, 120_000)

  it('a 401 mid-push refreshes the token once and still lands every row', async () => {
    await twoDevices(async (a) => {
      await seed(a, LOCAL, { n: 15 })
      let failNextRemoteInsert = true
      const flaky = {
        execute: async (sql: string, params?: Record<string, unknown>) => {
          if (failNextRemoteInsert && sql.startsWith(`INSERT INTO ${REMOTE}`)) {
            failNextRemoteInsert = false
            throw new Error('HTTP 401 Unauthorized: token expired')
          }
          return a.execute(sql, params)
        },
      } as unknown as HybridDuckDB
      const refreshToken = vi.fn(async () => {})
      const pusher = new R2Pusher({
        engine: flaky,
        watermark: new WatermarkStore({ kv: memoryKV(), defaultRetentionMs: TEN_YEARS_MS }),
        refreshToken,
        ...names(),
      })

      const result = await pusher.push(TABLE, ctx())
      expect(result).toMatchObject({ ok: true, rowsPushed: 15 })
      expect(refreshToken).toHaveBeenCalledTimes(1)
      expect(await count(a, REMOTE)).toBe(15)
    })
  }, 120_000)

  /*
   * KNOWN DEFECT — late-arriving rows are never pushed.
   *
   * The push watermark is EVENT time: `WHERE ts > watermark`, advanced to
   * max(ts). A ring delivers history out of order (a resync backfills older
   * readings; pages land across several flushes with a push cycle between
   * them), so a reading whose ts is older than the watermark reaches the
   * local table AFTER the watermark has passed it — and no later push ever
   * selects it. Every other device on the account never sees it
   * (zivaone_app#111's scenario). The fetch watermark has the same shape.
   *
   * Fixing it needs an ingestion-order cursor (or an anti-join against the
   * remote), which is a schema/design decision — not made here
   * (mongrov-packages#10). `it.fails`
   * keeps the suite green and goes red when the defect is fixed.
   */
  it.fails('KNOWN DEFECT: a row older than the push watermark that arrives later still reaches the remote', async () => {
    await twoDevices(async (a) => {
      const kv = memoryKV()
      await seed(a, LOCAL, { n: 10, startMin: 100 })
      await pusherFor(a, kv).push(TABLE, ctx())

      await seed(a, LOCAL, { n: 5, startMin: 0 }) // backfill: older, arrives later
      await pusherFor(a, kv).push(TABLE, ctx())

      expect(await count(a, REMOTE)).toBe(15)
    })
  }, 120_000)

  /*
   * KNOWN DEFECT — push is not idempotent across a crash.
   *
   * The remote INSERT and the watermark advance are two steps. A crash (or a
   * failed KV write) between them leaves the rows in R2 and the watermark
   * where it was, so the next push inserts them AGAIN — Iceberg has no
   * primary key to reject the duplicates, and every fetching device then
   * pulls both copies (its local PK dedupes, but the remote grows).
   * Recorded here for the same reason and with the same `it.fails` contract.
   */
  it.fails('KNOWN DEFECT: a push interrupted after its INSERT does not duplicate rows when retried', async () => {
    await twoDevices(async (a) => {
      await seed(a, LOCAL, { n: 8 })
      const kv = memoryKV()
      const crashingKv: KVStore = {
        get: key => kv.get(key),
        delete: key => kv.delete(key),
        set: async () => { throw new Error('process killed before the watermark was saved') },
      }
      await pusherFor(a, crashingKv).push(TABLE, ctx()) // INSERT lands; advance throws
      await pusherFor(a, kv).push(TABLE, ctx()) // restart: same watermark, same rows

      expect(await count(a, REMOTE)).toBe(8)
    })
  }, 120_000)
})
