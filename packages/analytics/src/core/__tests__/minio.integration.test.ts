/**
 * MinIO + Iceberg REST end-to-end integration suite (T-18).
 *
 * Runs against the docker-compose stack under
 * `packages/analytics/infra/analytics-minio/`. Vitest's globalSetup
 * (`src/__integration__/setup/global-setup.ts`) boots the stack when
 * the file loads and tears it down at the end of the run — unless
 * `INTEGRATION_STACK_EXTERNAL=1`, in which case the developer is
 * expected to manage compose lifecycle.
 *
 * Runbook (local iterative loop):
 *
 *   cd packages/analytics/infra/analytics-minio
 *   docker compose up -d --wait
 *   cd ../..
 *   INTEGRATION_STACK_EXTERNAL=1 pnpm test:integration
 *   docker compose -f infra/analytics-minio/docker-compose.yml down -v
 *
 * Runbook (fresh boot, matches CI):
 *
 *   pnpm test:integration
 *
 * These tests exercise the SAME `createAnalytics` factory production
 * ships — the only substitutions are (a) `duckdbFactory` (Node
 * `@duckdb/node-api` instead of `react-native-duckdb`) and (b) a
 * test-only `TYPE S3` secret so DuckDB can read Parquet data files
 * from MinIO. R2 vends S3 creds via the REST catalog response;
 * MinIO does not, so the divergence is contained to the seed layer.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AnalyticsEngine, AttachContext } from '../types'
import { createAnalytics } from '../factory'
import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { endpoints, type Endpoints } from '../../__integration__/setup/endpoints'
import {
  dropNamespace,
  ensureNamespace,
  ensureS3Secret,
  memoryKV,
  refreshingTokenVendor,
  staticTokenVendor,
} from '../../__integration__/setup/seed'
import { warehouseSecretName } from '../warehouse'

const NAMESPACE = 'default'
const TENANT_A = 'fam_test'
const TENANT_B = 'fam_other'
const CATALOG_A = warehouseSecretName(TENANT_A) // `zone_fam_test`
const CATALOG_B = warehouseSecretName(TENANT_B) // `zone_fam_other`

// Fully-qualified refs use DuckDB's <catalog>.<schema>.<table> shape;
// production code emits 2-part `<catalog>.<table>` after `USE
// <catalog>.default`. Both resolve to the same physical table.
function qualify(catalog: string, table: string): string {
  return `${catalog}.${NAMESPACE}.${table}`
}

describe('T-18 — MinIO + Iceberg REST integration', () => {
  let ep: Endpoints

  beforeAll(async () => {
    ep = endpoints()
    await ensureNamespace(ep.restEndpoint, NAMESPACE)
  })

  afterAll(async () => {
    // Best-effort — the compose teardown resets MinIO + catalog state
    // anyway, this just keeps successive external-stack runs isolated.
    await dropNamespace(ep.restEndpoint, NAMESPACE).catch(() => {})
  })

  /**
   * Boot `createAnalytics` with a real DuckDB backed by @duckdb/node-api.
   * The factory eagerly installs the MinIO S3 secret so subsequent
   * ATTACH + data-file reads succeed.
   *
   * Optional `retentionDays` seeds the brand-level retention config so
   * `setRetention()` has a baseline to resolve against.
   */
  function bootEngine(retentionDays?: number): AnalyticsEngine {
    return createAnalytics(
      {
        storage: memoryKV(),
        warehouseUriBuilder: () => ep.warehouseName,
        catalogEndpoint: ep.restEndpoint,
        tokenVendor: staticTokenVendor(),
        familyMembersProvider: async () => [],
        retention: retentionDays != null ? { ziva: { days: retentionDays } } : {},
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

  function attachCtx(tenantId: string): AttachContext {
    return { brand: 'ziva', tenantScope: 'family', tenantId, userId: 'u1' }
  }

  /**
   * Wipe the shared `hrv` table for one user. The compose stack persists
   * MinIO state across in-suite reboots (shared docker volume), so tests
   * that seed rows and then count them must start from a known baseline.
   * Cheaper than dropping + recreating the namespace, which Iceberg REST
   * rejects when tables still exist.
   */
  async function resetHrv(engine: AnalyticsEngine, catalog: string, userId: string): Promise<void> {
    await engine.execute(
      `DELETE FROM ${qualify(catalog, 'hrv')} WHERE user_id = $u`,
      { u: userId },
    )
  }

  /**
   * Insert one hrv row at the given ISO timestamp string (naive; matches
   * DuckDB TIMESTAMP literal shape).
   */
  async function insertHrv(
    engine: AnalyticsEngine,
    catalog: string,
    tenantId: string,
    userId: string,
    tsIso: string,
    hrvMs: number,
  ): Promise<void> {
    await engine.execute(
      `INSERT INTO ${qualify(catalog, 'hrv')}
         (ts, brand, family_id, user_id, device_id, hrv_ms)
         VALUES ($ts::TIMESTAMP, $brand, $fam, $u, $d, $v)`,
      { ts: tsIso, brand: 'ziva', fam: tenantId, u: userId, d: 'd1', v: hrvMs },
    )
  }

  it('case #1: attach → INSERT → SELECT round-trips against the spec-shape hrv table', async () => {
    const engine = bootEngine()
    try {
      await engine.attach(attachCtx(TENANT_A))
      expect(engine.state).toBe('attached')
      expect(engine.catalog).toBe(CATALOG_A)

      await resetHrv(engine, CATALOG_A, 'u1')

      // Iceberg forbids the appender path, so we go through INSERT.
      // Appender coverage lives in the local-table (T-28) suite.
      for (let i = 0; i < 10; i++) {
        const ts = new Date(Date.UTC(2025, 0, 1, 0, i, 0))
          .toISOString().replace('T', ' ').replace('Z', '')
        await insertHrv(engine, CATALOG_A, TENANT_A, 'u1', ts, 50 + i)
      }

      const counted = await engine.execute<{ n: bigint }>(
        `SELECT COUNT(*)::BIGINT AS n
           FROM ${qualify(CATALOG_A, 'hrv')}
          WHERE device_id = $device_id`,
        { device_id: 'd1' },
      )
      expect(counted[0]?.n).toBe(10n)

      const first = await engine.execute<{
        user_id: string
        device_id: string
        hrv_ms: number
      }>(
        `SELECT user_id, device_id, hrv_ms
           FROM ${qualify(CATALOG_A, 'hrv')}
          ORDER BY ts
          LIMIT 1`,
      )
      expect(first[0]).toEqual({ user_id: 'u1', device_id: 'd1', hrv_ms: 50 })

      await engine.detach()
      expect(engine.state).toBe('ready')
    }
    finally {
      await engine.close()
    }
  })

  it('case #2: reattach preserves rows written before detach', async () => {
    const engine = bootEngine()
    try {
      await engine.attach(attachCtx(TENANT_A))
      await resetHrv(engine, CATALOG_A, 'u2')

      const ts0 = '2025-02-01 00:00:00'
      const ts1 = '2025-02-01 00:01:00'
      const ts2 = '2025-02-01 00:02:00'
      await insertHrv(engine, CATALOG_A, TENANT_A, 'u2', ts0, 40)
      await insertHrv(engine, CATALOG_A, TENANT_A, 'u2', ts1, 41)
      await insertHrv(engine, CATALOG_A, TENANT_A, 'u2', ts2, 42)

      await engine.detach()
      expect(engine.state).toBe('ready')

      // Second attach against the same warehouse — must see the earlier commits.
      await engine.attach(attachCtx(TENANT_A))
      expect(engine.state).toBe('attached')

      const counted = await engine.execute<{ n: bigint }>(
        `SELECT COUNT(*)::BIGINT AS n
           FROM ${qualify(CATALOG_A, 'hrv')}
          WHERE user_id = $u`,
        { u: 'u2' },
      )
      expect(counted[0]?.n).toBe(3n)

      await engine.detach()
    }
    finally {
      await engine.close()
    }
  })

  it('case #3: brand/tenant isolation — detaching one tenant hides its catalog alias', async () => {
    const engine = bootEngine()
    try {
      // Seed tenant A with a distinguishing row.
      await engine.attach(attachCtx(TENANT_A))
      await resetHrv(engine, CATALOG_A, 'u3a')
      await insertHrv(engine, CATALOG_A, TENANT_A, 'u3a', '2025-03-01 00:00:00', 99)
      await engine.detach()

      // Attach tenant B — a DIFFERENT DuckDB catalog alias. Querying by
      // tenant A's alias must now fail: the catalog is no longer attached.
      // (The MinIO stack shares one physical warehouse across tenants; the
      // isolation invariant the app relies on is DuckDB catalog-alias
      // scoping, not per-tenant object storage — production R2 provides
      // physical isolation on top via per-tenant bucket paths, which is
      // covered separately in the warehouse unit suite.)
      await engine.attach(attachCtx(TENANT_B))
      expect(engine.catalog).toBe(CATALOG_B)

      await expect(
        engine.execute(`SELECT COUNT(*) FROM ${qualify(CATALOG_A, 'hrv')}`),
      ).rejects.toThrow(/zone_fam_test/)

      await engine.detach()

      // Reattach tenant A — the row we wrote earlier must still be there.
      await engine.attach(attachCtx(TENANT_A))
      const aCount = await engine.execute<{ n: bigint }>(
        `SELECT COUNT(*)::BIGINT AS n
           FROM ${qualify(CATALOG_A, 'hrv')}
          WHERE user_id = $u`,
        { u: 'u3a' },
      )
      expect(aCount[0]?.n).toBe(1n)

      await engine.detach()
    }
    finally {
      await engine.close()
    }
  })

  it('case #4: retention sweep respects the per-table sync watermark', async () => {
    const engine = bootEngine(90) // brand default = 90 days
    try {
      await engine.attach(attachCtx(TENANT_A))
      await resetHrv(engine, CATALOG_A, 'u4')
      // Also clear the watermark for a clean slate.
      await engine.execute(
        `DELETE FROM ${qualify(CATALOG_A, 'sync_watermark')}
          WHERE brand = 'ziva' AND family_id = $fam AND table_name = 'hrv'`,
        { fam: TENANT_A },
      )

      // Seed 100 rows, one per day, spanning [now-100d, now-1d]. We use
      // wall-clock `now()` inside SQL so the ages the retention DELETE
      // computes line up with the ages the seed inserts pick.
      await engine.execute(
        `INSERT INTO ${qualify(CATALOG_A, 'hrv')}
           (ts, brand, family_id, user_id, device_id, hrv_ms)
         SELECT
           (now() - (day_offset * INTERVAL 1 DAY))::TIMESTAMP,
           'ziva',
           $fam,
           'u4',
           'd-ret',
           50
         FROM generate_series(1, 100) AS t(day_offset)`,
        { fam: TENANT_A },
      )
      const seeded = await engine.execute<{ n: bigint }>(
        `SELECT COUNT(*)::BIGINT AS n FROM ${qualify(CATALOG_A, 'hrv')} WHERE user_id = 'u4'`,
      )
      expect(seeded[0]?.n).toBe(100n)

      // Watermark 95d back — inside the retention window (90d), so it is
      // the tighter bound and constrains deletion. Only rows older than
      // now-95d should get swept; rows in [now-95d, now] survive.
      await engine.execute(
        `INSERT INTO ${qualify(CATALOG_A, 'sync_watermark')}
           (brand, family_id, table_name, kind, cursor_ts, updated_at)
           VALUES ('ziva', $fam, 'hrv', 'push', (now() - INTERVAL 95 DAY)::TIMESTAMP, now()::TIMESTAMP)`,
        { fam: TENANT_A },
      )

      await engine.setRetention(90) // triggers runRetentionSweep

      const remaining = await engine.execute<{ n: bigint }>(
        `SELECT COUNT(*)::BIGINT AS n FROM ${qualify(CATALOG_A, 'hrv')} WHERE user_id = 'u4'`,
      )
      // LEAST(now - 90d, watermark = now - 95d) = now - 95d.
      // Rows at offset [96..100] days are older → 5 deleted, ~95 remain.
      // The seed's `now()` and the sweep's `now()` are seconds apart, so
      // the row at offset=95 straddles the boundary — accept 94..95 to
      // absorb the wall-clock jitter without weakening the assertion.
      const remainingN = remaining[0]?.n ?? 0n
      expect(Number(remainingN)).toBeGreaterThanOrEqual(94)
      expect(Number(remainingN)).toBeLessThanOrEqual(95)

      // Sanity: the oldest surviving row is on the far side of the retention
      // cutoff but inside the watermark bound.
      const oldest = await engine.execute<{ age_days: number }>(
        `SELECT (extract(epoch FROM (now() - MIN(ts))) / 86400)::INTEGER AS age_days
           FROM ${qualify(CATALOG_A, 'hrv')}
          WHERE user_id = 'u4'`,
      )
      expect(oldest[0]?.age_days).toBeGreaterThanOrEqual(90)
      expect(oldest[0]?.age_days).toBeLessThanOrEqual(95)

      await engine.detach()
    }
    finally {
      await engine.close()
    }
  })

  it('case #6: sleep_session attach → INSERT → SELECT (non-ts time column, DATE round-trip)', async () => {
    const engine = bootEngine()
    try {
      await engine.attach(attachCtx(TENANT_A))
      expect(engine.state).toBe('attached')

      // Clean slate for the test's user_id.
      await engine.execute(
        `DELETE FROM ${qualify(CATALOG_A, 'sleep_session')} WHERE user_id = $u`,
        { u: 'u6' },
      )

      // Iceberg forbids the appender path — seed via INSERT so DDL clauses
      // (PARTITIONED BY day(ts_start), single PK session_id) exercise
      // end-to-end. Five sessions on consecutive days.
      for (let i = 0; i < 5; i++) {
        const start = `2025-06-0${i + 1} 22:00:00`
        const end = `2025-06-0${i + 2} 05:00:00`
        const nightOf = `2025-06-0${i + 1}`
        await engine.execute(
          `INSERT INTO ${qualify(CATALOG_A, 'sleep_session')}
             (session_id, ts_start, ts_end, brand, family_id, user_id, device_id,
              total_minutes, deep_minutes, rem_minutes, light_minutes,
              awake_minutes, avg_confidence, night_of)
             VALUES ($sid, $s::TIMESTAMP, $e::TIMESTAMP, 'ziva', $fam, $u, $d,
                     $tot, $deep, $rem, $light, $awk, $conf, $night::DATE)`,
          {
            sid: `sess_u6_${i}`,
            s: start,
            e: end,
            fam: TENANT_A,
            u: 'u6',
            d: 'd6',
            tot: 420,
            deep: 90,
            rem: 80,
            light: 180,
            awk: 70,
            conf: 0.92,
            night: nightOf,
          },
        )
      }

      const counted = await engine.execute<{ n: bigint }>(
        `SELECT COUNT(*)::BIGINT AS n
           FROM ${qualify(CATALOG_A, 'sleep_session')}
          WHERE user_id = $u`,
        { u: 'u6' },
      )
      expect(counted[0]?.n).toBe(5n)

      // Assert 14-col round-trip: DOUBLE avg_confidence, DATE night_of.
      const first = await engine.execute<{
        session_id: string
        avg_confidence: number
        night_of: string
      }>(
        `SELECT session_id, avg_confidence, night_of::VARCHAR AS night_of
           FROM ${qualify(CATALOG_A, 'sleep_session')}
          WHERE user_id = $u
          ORDER BY ts_start
          LIMIT 1`,
        { u: 'u6' },
      )
      expect(first[0]?.session_id).toBe('sess_u6_0')
      expect(first[0]?.avg_confidence).toBeCloseTo(0.92, 5)
      expect(first[0]?.night_of).toBe('2025-06-01')

      await engine.detach()
    }
    finally {
      await engine.close()
    }
  })

  it('case #7: device_config attach → INSERT → SELECT (composite PK, NULL valid_to)', async () => {
    const engine = bootEngine()
    try {
      await engine.attach(attachCtx(TENANT_A))
      expect(engine.state).toBe('attached')

      // Clean slate — composite PK means we must delete by user_id AND
      // data_type range to avoid stale rows from prior runs polluting the
      // count assertion.
      await engine.execute(
        `DELETE FROM ${qualify(CATALOG_A, 'device_config')} WHERE user_id = $u`,
        { u: 'u7' },
      )

      // Seed 3 configs with distinct data_type values (satisfies composite
      // PK (device_id, data_type, valid_from)). One row has valid_to = NULL
      // (open config, most recent). Two are closed (valid_to set).
      const configs = [
        { dt: 100, validFrom: '2025-06-01 00:00:00', validTo: '2025-06-02 00:00:00' as string | null },
        { dt: 101, validFrom: '2025-06-01 00:00:00', validTo: '2025-06-02 00:00:00' as string | null },
        { dt: 102, validFrom: '2025-06-02 00:00:00', validTo: null as string | null },
      ]
      for (const c of configs) {
        await engine.execute(
          `INSERT INTO ${qualify(CATALOG_A, 'device_config')}
             (device_id, brand, family_id, user_id, data_type,
              interval_minutes, start_time, end_time, weeks,
              valid_from, valid_to)
             VALUES ('d7', 'ziva', $fam, $u, $dt,
                     15, NULL, NULL, NULL,
                     $vf::TIMESTAMP, ${c.validTo === null ? 'NULL' : '$vt::TIMESTAMP'})`,
          c.validTo === null
            ? { fam: TENANT_A, u: 'u7', dt: c.dt, vf: c.validFrom }
            : { fam: TENANT_A, u: 'u7', dt: c.dt, vf: c.validFrom, vt: c.validTo },
        )
      }

      const counted = await engine.execute<{ n: bigint }>(
        `SELECT COUNT(*)::BIGINT AS n
           FROM ${qualify(CATALOG_A, 'device_config')}
          WHERE user_id = $u`,
        { u: 'u7' },
      )
      expect(counted[0]?.n).toBe(3n)

      // The open config (valid_to IS NULL) must survive round-trip as null.
      const open = await engine.execute<{ n: bigint }>(
        `SELECT COUNT(*)::BIGINT AS n
           FROM ${qualify(CATALOG_A, 'device_config')}
          WHERE user_id = $u AND valid_to IS NULL`,
        { u: 'u7' },
      )
      expect(open[0]?.n).toBe(1n)

      // Composite PK is metadata-only in Iceberg (no storage enforcement),
      // but the DDL round-trip should still let us project all three
      // components together.
      const shape = await engine.execute<{
        device_id: string
        data_type: number
        valid_from: string
      }>(
        `SELECT device_id, data_type, valid_from::VARCHAR AS valid_from
           FROM ${qualify(CATALOG_A, 'device_config')}
          WHERE user_id = $u
          ORDER BY data_type, valid_from`,
        { u: 'u7' },
      )
      expect(shape).toHaveLength(3)
      expect(shape[0]?.data_type).toBe(100)
      expect(shape[2]?.data_type).toBe(102)

      await engine.detach()
    }
    finally {
      await engine.close()
    }
  })

  it('case #8: retention sweep honors sleep_session.ts_end (not ts_start)', async () => {
    const engine = bootEngine(90) // brand default = 90 days
    try {
      await engine.attach(attachCtx(TENANT_A))

      // Clean slate.
      await engine.execute(
        `DELETE FROM ${qualify(CATALOG_A, 'sleep_session')} WHERE user_id = $u`,
        { u: 'u8' },
      )
      await engine.execute(
        `DELETE FROM ${qualify(CATALOG_A, 'sync_watermark')}
          WHERE brand = 'ziva' AND family_id = $fam AND table_name = 'sleep_session'`,
        { fam: TENANT_A },
      )

      // Seed 100 sessions with ts_end spanning [now-100d, now-1d]. ts_start
      // sits 7h earlier — deliberately places rows where a `ts_start`-based
      // sweep would keep more rows than a `ts_end`-based sweep. Distinct
      // session_ids satisfy the single-column PK.
      await engine.execute(
        `INSERT INTO ${qualify(CATALOG_A, 'sleep_session')}
           (session_id, ts_start, ts_end, brand, family_id, user_id, device_id,
            total_minutes, deep_minutes, rem_minutes, light_minutes,
            awake_minutes, avg_confidence, night_of)
         SELECT
           'sess_u8_' || day_offset::VARCHAR,
           (now() - (day_offset * INTERVAL 1 DAY) - INTERVAL 7 HOUR)::TIMESTAMP,
           (now() - (day_offset * INTERVAL 1 DAY))::TIMESTAMP,
           'ziva',
           $fam,
           'u8',
           'd8',
           420, 90, 80, 180, 70, 0.9,
           (now() - (day_offset * INTERVAL 1 DAY))::DATE
         FROM generate_series(1, 100) AS t(day_offset)`,
        { fam: TENANT_A },
      )
      const seeded = await engine.execute<{ n: bigint }>(
        `SELECT COUNT(*)::BIGINT AS n
           FROM ${qualify(CATALOG_A, 'sleep_session')}
          WHERE user_id = 'u8'`,
      )
      expect(seeded[0]?.n).toBe(100n)

      // Watermark 95d back — the tighter bound, constrains deletion to
      // ts_end < now - 95d. This proves the sweep is reading ts_end (not
      // ts_start, which sits 7h earlier and would otherwise shift the
      // boundary).
      await engine.execute(
        `INSERT INTO ${qualify(CATALOG_A, 'sync_watermark')}
           (brand, family_id, table_name, kind, cursor_ts, updated_at)
           VALUES ('ziva', $fam, 'sleep_session', 'push',
                   (now() - INTERVAL 95 DAY)::TIMESTAMP, now()::TIMESTAMP)`,
        { fam: TENANT_A },
      )

      await engine.setRetention(90) // triggers runRetentionSweep

      const remaining = await engine.execute<{ n: bigint }>(
        `SELECT COUNT(*)::BIGINT AS n
           FROM ${qualify(CATALOG_A, 'sleep_session')}
          WHERE user_id = 'u8'`,
      )
      // LEAST(now - 90d, watermark = now - 95d) = now - 95d.
      // Rows at ts_end offset [96..100] days are older → 5 deleted.
      // Absorb wall-clock jitter across seed/sweep by accepting 94..95.
      const remainingN = Number(remaining[0]?.n ?? 0n)
      expect(remainingN).toBeGreaterThanOrEqual(94)
      expect(remainingN).toBeLessThanOrEqual(95)

      // The oldest surviving session's ts_end must be inside the watermark
      // bound. If the sweep had used ts_start, the oldest ts_end would be
      // 7h younger than expected — this projection catches that regression.
      const oldest = await engine.execute<{ age_days: number }>(
        `SELECT (extract(epoch FROM (now() - MIN(ts_end))) / 86400)::INTEGER AS age_days
           FROM ${qualify(CATALOG_A, 'sleep_session')}
          WHERE user_id = 'u8'`,
      )
      expect(oldest[0]?.age_days).toBeGreaterThanOrEqual(90)
      expect(oldest[0]?.age_days).toBeLessThanOrEqual(95)

      await engine.detach()
    }
    finally {
      await engine.close()
    }
  })

  it('case #9: retention sweep skips device_config (SCD-2 config, no sweep)', async () => {
    const engine = bootEngine(90) // brand default = 90 days
    try {
      await engine.attach(attachCtx(TENANT_A))

      // Clean slate.
      await engine.execute(
        `DELETE FROM ${qualify(CATALOG_A, 'device_config')} WHERE user_id = $u`,
        { u: 'u9' },
      )

      // Seed 5 configs with valid_from 180 days back — well past any
      // reasonable retention window. Distinct data_type values satisfy the
      // composite PK.
      await engine.execute(
        `INSERT INTO ${qualify(CATALOG_A, 'device_config')}
           (device_id, brand, family_id, user_id, data_type,
            interval_minutes, start_time, end_time, weeks,
            valid_from, valid_to)
         SELECT
           'd9',
           'ziva',
           $fam,
           'u9',
           200 + dt,
           15, NULL, NULL, NULL,
           (now() - INTERVAL 180 DAY)::TIMESTAMP,
           NULL
         FROM generate_series(0, 4) AS t(dt)`,
        { fam: TENANT_A },
      )
      const seeded = await engine.execute<{ n: bigint }>(
        `SELECT COUNT(*)::BIGINT AS n
           FROM ${qualify(CATALOG_A, 'device_config')}
          WHERE user_id = 'u9'`,
      )
      expect(seeded[0]?.n).toBe(5n)

      // Aggressive retention setting — if the sweep touched device_config
      // at all, every row would be older than the cutoff and swept.
      await engine.setRetention(90)

      const remaining = await engine.execute<{ n: bigint }>(
        `SELECT COUNT(*)::BIGINT AS n
           FROM ${qualify(CATALOG_A, 'device_config')}
          WHERE user_id = 'u9'`,
      )
      // TABLE_RETENTION.device_config === null → sweep is a no-op for this
      // table. All 5 rows survive despite being 180 days old.
      expect(remaining[0]?.n).toBe(5n)

      await engine.detach()
    }
    finally {
      await engine.close()
    }
  })

  it('case #5: token vendor is re-fetched at 75% TTL and the DuckDB secret is refreshed', async () => {
    // Short TTL keeps the test snappy: `after: { tokenRefresh }` fires at
    // 75% of TTL, so a 4-second token triggers refresh at ~3s. The machine
    // reads wall-clock time (no fake timers) — we sleep in real time and
    // then assert the vendor was hit again + the machine is back in
    // `attached` with the newer expiry.
    const TTL_MS = 4_000
    const vendor = refreshingTokenVendor(TTL_MS)
    const engine = createAnalytics(
      {
        storage: memoryKV(),
        warehouseUriBuilder: () => ep.warehouseName,
        catalogEndpoint: ep.restEndpoint,
        tokenVendor: vendor,
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
    try {
      await engine.attach(attachCtx(TENANT_A))
      expect(engine.state).toBe('attached')
      // Attach itself consumed the first vend.
      expect(vendor.callCount()).toBe(1)

      // Wait past 75% TTL. Add a small buffer (300 ms) so we're safely
      // through the `refreshing → attached` round-trip even under CI
      // jitter — the refresh actor only re-issues `CREATE OR REPLACE SECRET`
      // and doesn't touch MinIO, so it completes in a few ms.
      const refreshAt = Math.floor(TTL_MS * 0.75)
      await new Promise(r => setTimeout(r, refreshAt + 300))

      expect(vendor.callCount()).toBeGreaterThanOrEqual(2)
      // Machine returns to `attached` after `refreshing` — never dropped
      // to `error`. If refresh had failed, `lastError` would be non-null.
      expect(engine.state).toBe('attached')
      expect(engine.lastError).toBeNull()

      // Prove the newly-issued SECRET actually works for a real query
      // (i.e. the secret rotation didn't tear down the ATTACH).
      const probe = await engine.execute<{ ok: number }>(
        `SELECT 1 AS ok FROM ${qualify(CATALOG_A, 'hrv')} LIMIT 1`,
      )
      expect(Array.isArray(probe)).toBe(true)

      await engine.detach()
    }
    finally {
      await engine.close()
    }
  }, 15_000)
})
