// Sprint 5 Phase 8 — T-37 JOIN invalidation validator (spec §10,
// principle 48). Advisory console.warn at defineQuery time; never throws.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineQuery, extractReferencedTables } from '../index'

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

function defineDuckdb(sql: string, invalidatedBy?: string[]) {
  return defineQuery({
    engine: 'duckdb',
    output: z.unknown(),
    sql,
    ...(invalidatedBy ? { invalidatedBy } : {}),
  })
}

// --- extractReferencedTables ------------------------------------------

describe('T-37 · extractReferencedTables', () => {
  it('strips the v_ union-view prefix (v_spo2 → spo2)', () => {
    expect(extractReferencedTables('SELECT * FROM v_spo2')).toEqual(['spo2'])
  })

  it('collects FROM + JOIN tables, deduplicated', () => {
    const tables = extractReferencedTables(
      'SELECT * FROM v_spo2 s JOIN v_sleep_session ss ON s.ts = ss.ts '
      + 'LEFT JOIN v_spo2 dup ON dup.ts = s.ts',
    )
    expect(tables.sort()).toEqual(['sleep_session', 'spo2'])
  })

  it('excludes CTE names (WITH x AS / x(cols) AS)', () => {
    const tables = extractReferencedTables(`
      WITH params AS (SELECT 1),
           slots(slot_index) AS (SELECT generate_series(0, 47))
      SELECT * FROM slots s CROSS JOIN params p
      LEFT JOIN v_spo2 v ON v.slot = s.slot_index
    `)
    expect(tables).toEqual(['spo2'])
  })

  it('ignores set-returning function calls and subqueries after FROM', () => {
    const tables = extractReferencedTables(`
      SELECT * FROM generate_series(0, 30) AS t(n),
        (SELECT 1) sub
      JOIN insight i ON i.n = t.n
      WHERE extract('minute' FROM (now() - i.ts)) > 5
    `)
    expect(tables).toEqual(['insight'])
  })

  it('ignores schema-qualified internals like information_schema', () => {
    const tables = extractReferencedTables(
      'SELECT * FROM information_schema.tables JOIN user_baseline ub ON 1=1',
    )
    expect(tables).toEqual(['user_baseline'])
  })

  it('ignores tables mentioned only inside comments', () => {
    const tables = extractReferencedTables(
      '-- reuses spo2Day base; derived FROM v_sleep_session in transform\n'
      + 'SELECT * FROM insight /* was: JOIN v_activity */',
    )
    expect(tables).toEqual(['insight'])
  })
})

// --- validator behavior at defineQuery time ---------------------------

describe('T-37 · JOIN invalidation validator', () => {
  const TWO_TABLE_SQL
    = 'SELECT * FROM v_spo2 s JOIN v_sleep_session ss ON s.ts = ss.ts'

  it('warns when 2 tables referenced but only 1 covered, naming the missing table', () => {
    defineDuckdb(TWO_TABLE_SQL, ['spo2:insert', 'spo2:sync_complete'])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const message = String(warnSpy.mock.calls[0][0])
    expect(message).toContain('does not cover [sleep_session]')
    expect(message).toContain('principle 48')
  })

  it('never throws — warning only', () => {
    expect(() => defineDuckdb(TWO_TABLE_SQL, ['spo2:insert'])).not.toThrow()
  })

  it('silent when every referenced table is covered', () => {
    defineDuckdb(TWO_TABLE_SQL, [
      'spo2:insert',
      'sleep_session:sync_complete',
    ])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('batch:* entries cover all tables', () => {
    defineDuckdb(TWO_TABLE_SQL, ['batch:complete'])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('warns with no invalidatedBy at all when ≥2 tables referenced', () => {
    defineDuckdb(TWO_TABLE_SQL)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const message = String(warnSpy.mock.calls[0][0])
    expect(message).toContain('spo2')
    expect(message).toContain('sleep_session')
  })

  it('silent for single-table SQL regardless of invalidatedBy', () => {
    defineDuckdb('SELECT * FROM v_spo2')
    defineDuckdb('SELECT * FROM insight', ['unrelated:event'])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('CTE names do not count toward the 2-table threshold', () => {
    defineDuckdb(`
      WITH params AS (SELECT 1), days(d) AS (SELECT generate_series(0, 6))
      SELECT * FROM days d CROSS JOIN params p
      LEFT JOIN v_spo2 v ON 1=1
    `)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('comment-only SQL is silent', () => {
    defineDuckdb('-- reuses spo2Day base; server derives table rows')
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

// --- frozen contract gate ---------------------------------------------
//
// SQL + invalidatedBy below are copied verbatim from the frozen contract
// (techspec/queries.ts). The validator must stay silent on every
// definition there — spec §10 shows spo2.day as the canonical
// fully-covered JOIN query.

describe('T-37 · frozen contract (techspec/queries.ts) stays warning-free', () => {
  it('spo2.day — 3-table JOIN with full coverage → silent', () => {
    defineDuckdb(
      `
    WITH
      /* Target date range in user's local timezone */
      params AS (
        SELECT
          date_trunc('day', timezone($tz, now()) - INTERVAL ($offset) DAY) AS local_day_start,
          date_trunc('day', timezone($tz, now()) - INTERVAL ($offset - 1) DAY) AS local_day_end
      ),
      /* 30-min slot grid (0..47) */
      slots(slot_index) AS (SELECT generate_series(0, 47)),
      /* Slot boundaries in UTC */
      slot_bounds AS (
        SELECT
          s.slot_index,
          p.local_day_start + INTERVAL (s.slot_index * 30) MINUTE AS ts_start_local,
          p.local_day_start + INTERVAL ((s.slot_index + 1) * 30) MINUTE AS ts_end_local
        FROM slots s CROSS JOIN params p
      ),
      /* Aggregate SpO2 per slot */
      slot_readings AS (
        SELECT
          sb.slot_index,
          sb.ts_start_local,
          avg(v.value) AS value_avg
        FROM slot_bounds sb
        LEFT JOIN v_spo2 v
          ON v.user_id = $userId
         AND v.brand = $brand
         AND v.family_id = $familyId
         AND timezone($tz, v.ts) >= sb.ts_start_local
         AND timezone($tz, v.ts) < sb.ts_end_local
        GROUP BY sb.slot_index, sb.ts_start_local
      ),
      /* Classify each slot: asleep / active / awake */
      slot_context AS (
        SELECT
          sr.slot_index,
          sr.ts_start_local,
          sr.value_avg,
          CASE
            WHEN EXISTS (
              SELECT 1 FROM v_sleep_session ss
              WHERE ss.user_id = $userId AND ss.brand = $brand AND ss.family_id = $familyId
                AND timezone($tz, ss.ts_start) <= sr.ts_start_local
                AND timezone($tz, ss.ts_end) > sr.ts_start_local
            ) THEN 'asleep'
            WHEN COALESCE((
              SELECT sum(steps) FROM v_activity a
              WHERE a.user_id = $userId AND a.brand = $brand AND a.family_id = $familyId
                AND timezone($tz, a.ts) >= sr.ts_start_local
                AND timezone($tz, a.ts) < sr.ts_start_local + INTERVAL 30 MINUTE
            ), 0) > 200 THEN 'active'
            ELSE 'awake'
          END AS context
        FROM slot_readings sr
      )
    SELECT * FROM slot_context ORDER BY slot_index
  `,
      [
        'spo2:insert',
        'spo2:sync_complete',
        'sleep_session:insert',
        'sleep_session:sync_complete',
        'activity:insert',
        'activity:sync_complete',
        'batch:complete',
        'user_setting:changed:spo2SafeLevel',
      ],
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('spo2.day tables resolve to exactly {spo2, sleep_session, activity}', () => {
    const tables = extractReferencedTables(`
      WITH params AS (SELECT 1),
        slots(slot_index) AS (SELECT generate_series(0, 47)),
        slot_bounds AS (SELECT * FROM slots s CROSS JOIN params p),
        slot_readings AS (
          SELECT * FROM slot_bounds sb LEFT JOIN v_spo2 v ON 1=1
        ),
        slot_context AS (
          SELECT *,
            CASE WHEN EXISTS (SELECT 1 FROM v_sleep_session ss)
                 WHEN COALESCE((SELECT sum(steps) FROM v_activity a), 0) > 200 THEN 'active'
            END AS context
          FROM slot_readings sr
        )
      SELECT * FROM slot_context
    `)
    expect(tables.sort()).toEqual(['activity', 'sleep_session', 'spo2'])
  })

  it('spo2.baselineMaturity — v_spo2 + user_baseline, both covered → silent', () => {
    defineDuckdb(
      `
    SELECT
      COALESCE(ub.sample_count, 0) AS sample_count_days,
      count(DISTINCT date_trunc('day', timezone($tz, v.ts))) AS observed_days
    FROM v_spo2 v
    LEFT JOIN user_baseline ub
      ON ub.user_id = $userId AND ub.brand = $brand AND ub.family_id = $familyId
     AND ub.metric = 'spo2' AND ub.window_days = 30
    WHERE v.user_id = $userId AND v.brand = $brand AND v.family_id = $familyId
    GROUP BY ub.sample_count
  `,
      ['spo2:sync_complete', 'user_baseline:updated', 'batch:complete'],
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('spo2.month — CTE range + generate_series alias, single real table → silent', () => {
    defineDuckdb(
      `
    WITH params AS (
      SELECT
        date_trunc('month', timezone($tz, now()) - INTERVAL ($offset) MONTH) AS month_start
    ),
    day_range AS (
      SELECT
        p.month_start + INTERVAL (n) DAY AS day
      FROM params p, generate_series(0, 30) AS t(n)
      WHERE p.month_start + INTERVAL (n) DAY < p.month_start + INTERVAL 1 MONTH
    )
    SELECT
      dr.day::VARCHAR AS day,
      avg(v.value) AS avg
    FROM day_range dr
    LEFT JOIN v_spo2 v
      ON v.user_id = $userId AND v.brand = $brand AND v.family_id = $familyId
     AND date_trunc('day', timezone($tz, v.ts)) = dr.day
    GROUP BY dr.day
    ORDER BY dr.day
  `,
      ['spo2:insert', 'spo2:sync_complete', 'batch:complete'],
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('device.lastSyncedAt — extract(\'minute\' FROM (...)) is not a table → silent', () => {
    defineDuckdb(
      `
    SELECT
      max(ts)::VARCHAR AS last_synced_at,
      cast(extract('minute' FROM (now() - max(ts))) AS INTEGER) AS minutes_since_sync
    FROM v_device_event
    WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
      AND event_type = 'sync_completed'
  `,
      ['device_event:insert', 'device_event:sync_complete'],
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('spo2.dayTableRows — comment-only SQL → silent', () => {
    defineDuckdb(
      '-- reuses spo2Day base; server derives table rows in transform',
      [
        'spo2:insert',
        'spo2:sync_complete',
        'sleep_session:insert',
        'activity:insert',
        'batch:complete',
      ],
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
