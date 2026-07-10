/**
 * MinIO + Iceberg REST end-to-end integration suite (T-18).
 *
 * All tests are `describe.skip`'d because they require Docker + testcontainers
 * infra that is not yet wired into CI. The shape below documents the
 * intended coverage per spec §Attach Protocol + §Retention + `tasks.md#T-18`.
 *
 * Runbook (manual) — remove the `.skip` and:
 *
 *   1. Ensure Docker is running.
 *   2. Start MinIO + Iceberg REST via docker-compose (see infra/analytics-minio
 *      once landed).
 *   3. Point `TEST_CATALOG_ENDPOINT` at the REST endpoint and export
 *      `TEST_S3_ENDPOINT` + credentials.
 *   4. `pnpm vitest run minio.integration`
 *
 * Prerequisites tracked as blockers on T-18:
 *   - testcontainers-vitest wiring
 *   - Iceberg REST + MinIO docker-compose recipe
 *   - CI job with Docker access (opt-in nightly)
 */

import { describe, it } from 'vitest'

describe.skip('T-18 — MinIO + Iceberg REST integration', () => {
  it('attach → INSERT via appender → SELECT round-trips', async () => {
    // 1. createAnalytics with real duckdbFactory + config pointing at the
    //    testcontainer endpoints.
    // 2. engine.attach({ brand: 'ziva', tenantScope: 'family',
    //      tenantId: 'fam_test', userId: 'u1' })
    // 3. const appender = engine.createAppender('hrv')
    //    for (const row of seededRows) appender.appendRow(row)
    //    await appender.flush()
    // 4. const rows = await engine.execute(
    //      'SELECT COUNT(*) AS n FROM zone_fam_test.hrv WHERE device_id = $device_id',
    //      { device_id: 'd1' },
    //    )
    //    expect(rows[0].n).toBe(seededRows.length)
    // 5. await engine.detach()
  })

  it('reattach after detach re-establishes the catalog cleanly', async () => {
    // engine.attach → engine.detach → engine.attach again
    // Assert the second attach succeeds and prior data is queryable.
  })

  it('brand switch leaves no cross-brand visibility', async () => {
    // attach brand: 'ziva' → insert rows → detach.
    // attach brand: 'luminx' → confirm zone_fam_test.hrv from ziva is NOT reachable.
    // detach → reattach ziva → confirm original rows still there.
  })

  it('retention sweep respects sync_watermark on the live warehouse', async () => {
    // Seed 100 days of hrv rows; INSERT sync_watermark row at t=now()-30d.
    // setRetention(90) → sweep runs.
    // Rows older than 30d SHOULD remain (bounded by watermark).
    // Rows older than 90d + inside watermark boundary SHOULD be deleted.
  })

  it('token refresh at 75% TTL re-issues CREATE OR REPLACE SECRET', async () => {
    // Configure tokenVendor with short (10s) TTL.
    // Wait > 7.5s.
    // Assert a second bearer token was minted via a spy on tokenVendor.fetch.
    // Assert queries continue to succeed after refresh.
  })
})
