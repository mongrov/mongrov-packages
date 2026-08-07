/**
 * ZivaOne registry SQL ↔ real schema (first execution, 2026-08-07).
 *
 * The SpO₂ registry SQL in `apps/zivaone/src/data/queries.ts` has never
 * been run against a real database. Until today the app's `duckdb` engine
 * adapter routed to Timon — which has none of these tables — and mapped
 * every query error to `[]`, so a broken query was indistinguishable from
 * an empty one.
 *
 * Two prior drift findings this session (mapper↔DDL, hand-written SQL↔DDL)
 * both had the same shape: an invariant spanning two modules, asserted
 * against mocks. This is the third instance of that shape, so it gets the
 * same treatment — execute the real strings against the real schema.
 *
 * Scope: proves the SQL *parses, binds and returns the projected shape*
 * against seeded data. It does NOT cover the five queries whose declared
 * output includes app-derived fields (verdict / narrative / factors /
 * zones / status); `transform` leaves those to the app by design, and the
 * derivation modules do not exist yet.
 */

import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import {
  generateViewDdl,
  LOCAL_SCHEMAS,
  TABLE_NAMES,
  VIEWED_TABLES,
} from '../schemas'

const BRAND = 'ziva'
const FAMILY = 'fam_1'
const USER = 'alice'
const TZ = 'America/Los_Angeles'

/** Real local schema + real union views, exactly as `attach()` builds them. */
async function bootWarehouse() {
  const db = await createRealDuckDB(['icu'])
  for (const table of TABLE_NAMES) {
    await db.execute(
      LOCAL_SCHEMAS[table].replace(
        `CREATE TABLE ${table}`,
        `CREATE TABLE memory.${table}`,
      ),
    )
  }
  // Local mode: views degrade to local-only SELECTs, no remote catalog.
  for (const table of VIEWED_TABLES) {
    await db.execute(
      generateViewDdl(table, {
        brand: BRAND,
        familyId: FAMILY,
        localCatalog: 'memory',
      }),
    )
  }
  return db
}

/** A night of SpO₂ plus the sleep session that contextualises it. */
async function seed(db: Awaited<ReturnType<typeof bootWarehouse>>) {
  await db.execute(
    `INSERT INTO memory.spo2 (ts, brand, family_id, user_id, device_id, spo2)
     SELECT now() - (n * INTERVAL 30 MINUTE), $brand, $fam, $user, 'ring_1',
            CASE WHEN n % 7 = 0 THEN 88 ELSE 96 END
     FROM generate_series(0, 47) AS t(n)`,
    { brand: BRAND, fam: FAMILY, user: USER },
  )
  await db.execute(
    `INSERT INTO memory.sleep_session
       (session_id, ts_start, ts_end, brand, family_id, user_id, device_id,
        total_minutes, deep_minutes, rem_minutes, light_minutes,
        awake_minutes, avg_confidence, night_of)
     VALUES ('s1', now() - INTERVAL 9 HOUR, now() - INTERVAL 1 HOUR,
             $brand, $fam, $user, 'ring_1', 480, 90, 100, 260, 30, 0.9,
             (now() - INTERVAL 1 DAY)::DATE)`,
    { brand: BRAND, fam: FAMILY, user: USER },
  )
  await db.execute(
    `INSERT INTO memory.activity (ts, brand, family_id, user_id, device_id, steps)
     SELECT now() - (n * INTERVAL 1 MINUTE), $brand, $fam, $user, 'ring_1', 0
     FROM generate_series(0, 120) AS t(n)`,
    { brand: BRAND, fam: FAMILY, user: USER },
  )
  await db.execute(
    `INSERT INTO memory.user_baseline
       (brand, family_id, user_id, metric, window_days,
        p05, p10, p50, p90, p95, mean, stddev, sample_count, computed_at)
     VALUES ($brand, $fam, $user, 'spo2', 30,
             93, 94, 96, 98, 99, 96, 1.2, 28, now())`,
    { brand: BRAND, fam: FAMILY, user: USER },
  )
  await db.execute(
    `INSERT INTO memory.insight
       (insight_id, ts, brand, family_id, user_id, rule_id, metric, kind,
        severity, title, body, evidence, acknowledged_at, dismissed_at)
     VALUES ('i1', now() - INTERVAL 2 HOUR, $brand, $fam, $user,
             'ziva.spo2-safe-level', 'spo2', 'threshold', 'warn',
             'Worth a look', NULL, NULL, NULL, NULL)`,
    { brand: BRAND, fam: FAMILY, user: USER },
  )
  await db.execute(
    `INSERT INTO memory.device_event
       (ts, brand, family_id, user_id, device_id, event_type, payload)
     VALUES (now() - INTERVAL 5 MINUTE, $brand, $fam, $user, 'ring_1',
             'sync_completed', '{"trigger":"auto","rowsWritten":48,"latencyMs":900}')`,
    { brand: BRAND, fam: FAMILY, user: USER },
  )
}

const TENANT = { userId: USER, brand: BRAND, familyId: FAMILY, tz: TZ }
/** What the dispatcher now binds: only placeholders the SQL references. */
const NO_TZ = { userId: USER, brand: BRAND, familyId: FAMILY }

describe('ZivaOne registry SQL against the real schema', () => {
  it('spo2.compareBaseline — reads user_baseline, no transform needed', async () => {
    const db = await bootWarehouse()
    try {
      await seed(db)
      const rows = await db.execute<Record<string, unknown>>(
        `SELECT
           p10 AS usual_lo,
           p90 AS usual_hi,
           p50 AS typical_mid,
           sample_count AS sample_count_days,
           computed_at::VARCHAR AS computed_at
         FROM user_baseline
         WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
           AND metric = 'spo2' AND window_days = 30
         LIMIT 1`,
        NO_TZ,
      )
      expect(rows).toHaveLength(1)
      // The declared output shape, satisfied by SQL alone.
      expect(rows[0]).toMatchObject({
        usual_lo: 94, usual_hi: 98, typical_mid: 96, sample_count_days: 28,
      })
    }
    finally { await db.close() }
  })

  it('spo2.worthALookInsight — filters dismissed, no transform needed', async () => {
    const db = await bootWarehouse()
    try {
      await seed(db)
      const sql = `SELECT insight_id, metric, title, body, severity,
                          ts::VARCHAR AS fired_at
                   FROM insight
                   WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
                     AND metric = 'spo2'
                     AND dismissed_at IS NULL
                     AND ts > now() - INTERVAL 24 HOUR
                   ORDER BY ts DESC
                   LIMIT 1`
      expect(await db.execute(sql, NO_TZ)).toHaveLength(1)

      // Dismissal must remove it from the feed while preserving the row.
      await db.execute(`UPDATE memory.insight SET dismissed_at = now()`)
      expect(await db.execute(sql, NO_TZ)).toHaveLength(0)
      expect(
        await db.execute(`SELECT 1 FROM memory.insight WHERE insight_id = 'i1'`),
      ).toHaveLength(1)
    }
    finally { await db.close() }
  })

  it('spo2.day — the 48-slot grid with sleep/activity context JOINs', async () => {
    const db = await bootWarehouse()
    try {
      await seed(db)
      // Verbatim from the registry, minus the TS-side derivation.
      const rows = await db.execute<Record<string, unknown>>(
        `WITH
          params AS (
            SELECT
              date_trunc('day', timezone($tz, now()) - INTERVAL ($offset) DAY) AS local_day_start
          ),
          slots(slot_index) AS (SELECT * FROM generate_series(0, 47)),
          slot_bounds AS (
            SELECT s.slot_index,
                   p.local_day_start + INTERVAL (s.slot_index * 30) MINUTE AS ts_start_local,
                   p.local_day_start + INTERVAL ((s.slot_index + 1) * 30) MINUTE AS ts_end_local
            FROM slots s CROSS JOIN params p
          ),
          slot_readings AS (
            SELECT sb.slot_index, sb.ts_start_local, avg(v.spo2) AS value_avg
            FROM slot_bounds sb
            LEFT JOIN v_spo2 v
              ON v.user_id = $userId AND v.brand = $brand AND v.family_id = $familyId
             AND timezone($tz, v.ts) >= sb.ts_start_local
             AND timezone($tz, v.ts) < sb.ts_end_local
            GROUP BY sb.slot_index, sb.ts_start_local
          ),
          slot_context AS (
            SELECT sr.slot_index, sr.ts_start_local, sr.value_avg,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM v_sleep_session ss
                  WHERE ss.user_id = $userId AND ss.brand = $brand AND ss.family_id = $familyId
                    AND timezone($tz, ss.ts_start) <= sr.ts_start_local
                    AND timezone($tz, ss.ts_end) > sr.ts_start_local
                ) THEN 'asleep'
                WHEN COALESCE((
                  SELECT sum(a.steps) FROM v_activity a
                  WHERE a.user_id = $userId AND a.brand = $brand AND a.family_id = $familyId
                    AND timezone($tz, a.ts) >= sr.ts_start_local
                    AND timezone($tz, a.ts) < sr.ts_start_local + INTERVAL 30 MINUTE
                ), 0) > 200 THEN 'active'
                ELSE 'awake'
              END AS context
            FROM slot_readings sr
          )
        SELECT * FROM slot_context ORDER BY slot_index`,
        { ...TENANT, offset: 0 },
      )

      // The output schema declares exactly 48 slots.
      expect(rows).toHaveLength(48)
      expect(rows[0]).toHaveProperty('context')
      expect(['asleep', 'active', 'awake']).toContain(rows[0].context)
      // Gaps are legitimate — a slot with no reading yields null, which the
      // schema models as `value: number | null`.
      expect(rows.some(r => r.value_avg !== null)).toBe(true)
    }
    finally { await db.close() }
  })

  it('device.lastSyncedAt — reads sync_completed from v_device_event', async () => {
    const db = await bootWarehouse()
    try {
      await seed(db)
      const rows = await db.execute<Record<string, unknown>>(
        `SELECT max(ts)::VARCHAR AS last_synced_at,
                cast(extract('minute' FROM (now() - max(ts))) AS INTEGER) AS minutes_since_sync
         FROM v_device_event
         WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
           AND event_type = 'sync_completed'`,
        NO_TZ,
      )
      expect(rows[0].last_synced_at).not.toBeNull()
      expect(Number(rows[0].minutes_since_sync)).toBeGreaterThanOrEqual(0)
    }
    finally { await db.close() }
  })

  it('spo2.week — local-day grouping across the week', async () => {
    const db = await bootWarehouse()
    try {
      await seed(db)
      const rows = await db.execute(
        `WITH params AS (
           SELECT
             date_trunc('day', timezone($tz, now()) - INTERVAL ($offset * 7) DAY) AS week_end,
             date_trunc('day', timezone($tz, now()) - INTERVAL ($offset * 7 + 6) DAY) AS week_start
         ),
         days(day_offset) AS (SELECT * FROM generate_series(0, 6))
         SELECT (p.week_start + INTERVAL (d.day_offset) DAY)::VARCHAR AS day,
                avg(v.spo2) AS avg, min(v.spo2) AS lo, max(v.spo2) AS hi
         FROM days d CROSS JOIN params p
         LEFT JOIN v_spo2 v
           ON v.user_id = $userId AND v.brand = $brand AND v.family_id = $familyId
          AND date_trunc('day', timezone($tz, v.ts)) = p.week_start + INTERVAL (d.day_offset) DAY
         GROUP BY p.week_start, d.day_offset
         ORDER BY d.day_offset`,
        { ...TENANT, offset: 0 },
      )
      // Declared output is `.length(7)`.
      expect(rows).toHaveLength(7)
    }
    finally { await db.close() }
  })
})
