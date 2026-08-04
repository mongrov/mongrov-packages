import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { HybridDuckDB } from '../engine'
import {
  AUDIT_RETENTION_DAYS,
  buildDeleteSql,
  INSIGHT_RETENTION_DAYS,
  resolveEffectiveRetention,
  runRetentionSweep,
} from '../retention'
import { ensureSchemas, LOCAL_SCHEMAS } from '../schemas'

import { createFakeDuckDB } from './__fakes__/fake-duckdb'

describe('resolveEffectiveRetention', () => {
  it('returns brand default when no override or family layer', () => {
    expect(resolveEffectiveRetention({ brandDefault: 90 })).toBe(90)
  })

  it('honours user override when higher (max wins)', () => {
    expect(
      resolveEffectiveRetention({ brandDefault: 60, userOverride: 180 }),
    ).toBe(180)
  })

  it('keeps brand default when user override is lower — spec: any layer that would preserve wins', () => {
    expect(
      resolveEffectiveRetention({ brandDefault: 90, userOverride: 30 }),
    ).toBe(90)
  })

  it('honours family setting when highest', () => {
    expect(
      resolveEffectiveRetention({
        brandDefault: 60,
        familySetting: 120,
        userOverride: 30,
      }),
    ).toBe(120)
  })

  it('treats undefined layers as 0', () => {
    expect(resolveEffectiveRetention({ brandDefault: 0 })).toBe(0)
  })
})

describe('buildDeleteSql', () => {
  it('emits a plain retention cutoff without watermark bound', () => {
    const sql = buildDeleteSql({
      catalog: 'memory',
      table: 'tool_call_audit',
      tsCol: 'ts',
      days: 30,
    })
    expect(sql).toBe(
      `DELETE FROM memory.tool_call_audit WHERE ts < now() - INTERVAL '30 days';`,
    )
  })

  it('bounds by LEAST(cutoff, $pushWatermark) for pushed tables', () => {
    const sql = buildDeleteSql({
      catalog: 'memory',
      table: 'hrv',
      tsCol: 'ts',
      days: 90,
      watermarkBound: true,
    })
    expect(sql).toContain('DELETE FROM memory.hrv')
    expect(sql).toContain('ts < LEAST(')
    expect(sql).toContain(`now() - INTERVAL '90 days'`)
    expect(sql).toContain('CAST($pushWatermark AS TIMESTAMP)')
  })

  it('respects a non-default ts column (sleep_session uses ts_end)', () => {
    const sql = buildDeleteSql({
      catalog: 'memory',
      table: 'sleep_session',
      tsCol: 'ts_end',
      days: 60,
      watermarkBound: true,
    })
    expect(sql).toContain('ts_end < LEAST(')
    expect(sql).toContain(`INTERVAL '60 days'`)
  })
})

describe('runRetentionSweep (scripted engine)', () => {
  it('local mode: one plain DELETE per retention-managed table (skips device_config + sync_watermark)', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()
    const openCalls = fake.calls.length

    const result = await runRetentionSweep(db, 'memory', {
      effectiveDays: 90,
      mode: 'local',
    })
    const deletes = fake.calls.slice(openCalls).filter(c => c.sql.startsWith('DELETE FROM'))

    // 15 tables total in SCHEMAS; device_config + sync_watermark skipped → 13 DELETEs.
    expect(deletes).toHaveLength(13)
    expect(result.swept).toHaveLength(13)
    expect(result.skipped).toEqual([])
    const swept = new Set(result.swept.map(e => e.table))
    expect(swept.has('device_config')).toBe(false)
    expect(swept.has('sync_watermark')).toBe(false)
    expect(swept.has('hrv')).toBe(true)
    expect(swept.has('insight')).toBe(true)
    expect(swept.has('tool_call_audit')).toBe(true)
    // Local mode: no push exists, plain cutoff on every table.
    for (const call of deletes) {
      expect(call.sql).not.toContain('$pushWatermark')
    }
  })

  it('uses fixed 90d for insight and 30d for tool_call_audit', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()

    const result = await runRetentionSweep(db, 'memory', {
      effectiveDays: 180,
      mode: 'local',
    })
    const insight = result.swept.find(e => e.table === 'insight')
    const audit = result.swept.find(e => e.table === 'tool_call_audit')
    const hrv = result.swept.find(e => e.table === 'hrv')
    expect(insight?.days).toBe(INSIGHT_RETENTION_DAYS)
    expect(audit?.days).toBe(AUDIT_RETENTION_DAYS)
    expect(hrv?.days).toBe(180)
  })

  it('r2 mode with no watermarks: skips every pushed table, still sweeps tool_call_audit', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()
    const openCalls = fake.calls.length

    const result = await runRetentionSweep(db, 'memory', {
      effectiveDays: 90,
      mode: 'r2',
      getPushWatermark: async () => null,
    })

    // Only the non-pushed internal table gets a DELETE.
    expect(result.swept.map(e => e.table)).toEqual(['tool_call_audit'])
    // 12 pushed tables (11 sensor + insight) skipped untouched.
    expect(result.skipped).toHaveLength(12)
    expect(result.skipped).toContain('hrv')
    expect(result.skipped).toContain('insight')
    const deletes = fake.calls.slice(openCalls).filter(c => c.sql.startsWith('DELETE FROM'))
    expect(deletes).toHaveLength(1)
  })

  it('r2 mode with missing accessor behaves like no watermark (delete nothing pushed)', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()

    const result = await runRetentionSweep(db, 'memory', { effectiveDays: 90 })
    expect(result.swept.map(e => e.table)).toEqual(['tool_call_audit'])
    expect(result.skipped).toHaveLength(12)
  })

  it('r2 mode binds $pushWatermark per table when a watermark exists', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()
    const openCalls = fake.calls.length
    const wm = new Date('2026-07-01T00:00:00.000Z')

    const result = await runRetentionSweep(db, 'memory', {
      effectiveDays: 90,
      mode: 'r2',
      getPushWatermark: async table => (table === 'hrv' ? wm : null),
    })

    expect(result.swept.map(e => e.table).sort()).toEqual(['hrv', 'tool_call_audit'])
    const hrvDelete = fake.calls
      .slice(openCalls)
      .find(c => c.sql.startsWith('DELETE FROM memory.hrv'))
    expect(hrvDelete).toBeDefined()
    expect(hrvDelete?.sql).toContain('LEAST(')
    expect(hrvDelete?.sql).toContain('CAST($pushWatermark AS TIMESTAMP)')
    expect(hrvDelete?.params).toEqual({ pushWatermark: wm.toISOString() })
  })

  it('wraps engine failures in AnalyticsError with retention_failed code', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()

    fake.failNextExecute(new Error('disk full'))

    await expect(
      runRetentionSweep(db, 'memory', { effectiveDays: 90, mode: 'local' }),
    ).rejects.toMatchObject({
      name: 'AnalyticsError',
      code: 'retention_failed',
    })

    // Same call, second invocation — no scripted failure — succeeds.
    await expect(
      runRetentionSweep(db, 'memory', { effectiveDays: 90, mode: 'local' }),
    ).resolves.toBeDefined()
  })
})

// -------------------- live local DuckDB scenarios (fix CO-1) --------------------

const DAY_MS = 24 * 60 * 60 * 1000

async function bootReal(): Promise<HybridDuckDB> {
  const db = new HybridDuckDB(() => createRealDuckDB([]))
  await db.open()
  await ensureSchemas(db, 'memory', LOCAL_SCHEMAS)
  return db
}

async function insertHrv(db: HybridDuckDB, daysAgo: number): Promise<void> {
  await db.execute(
    `INSERT INTO memory.hrv (ts, brand, family_id, user_id, device_id, hrv_ms)
     VALUES (now() - INTERVAL '${daysAgo} days', 'b', 'f', 'u', 'd', 50)`,
  )
}

async function count(db: HybridDuckDB, table: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    `SELECT CAST(COUNT(*) AS INTEGER) AS n FROM memory.${table}`,
  )
  return Number(rows[0]?.n ?? 0)
}

describe('runRetentionSweep — live local DuckDB', () => {
  it('r2 mode, nothing pushed yet: sensor + insight rows survive, audit is cleaned', async () => {
    const db = await bootReal()
    try {
      await insertHrv(db, 100)
      await insertHrv(db, 1)
      await db.execute(
        `INSERT INTO memory.insight (insight_id, ts, brand, family_id, user_id, metric, kind, severity, title)
         VALUES ('i1', now() - INTERVAL '100 days', 'b', 'f', 'u', 'hrv_ms', 'threshold', 'warn', 't')`,
      )
      await db.execute(
        `INSERT INTO memory.tool_call_audit (ts, brand, family_id, requester_user_id, tool_name, args, outcome)
         VALUES (now() - INTERVAL '40 days', 'b', 'f', 'u', 'getHRV', '{}', 'ok')`,
      )

      const result = await runRetentionSweep(db, 'memory', {
        effectiveDays: 90,
        mode: 'r2',
        getPushWatermark: async () => null,
      })

      expect(await count(db, 'hrv')).toBe(2) // nothing reached R2 → nothing deleted
      expect(await count(db, 'insight')).toBe(1) // insight is pushed too → guarded
      expect(await count(db, 'tool_call_audit')).toBe(0) // never pushed → plain 30d cutoff
      expect(result.skipped).toContain('hrv')
      expect(result.skipped).toContain('insight')
    }
    finally {
      await db.close()
    }
  })

  it('r2 mode, watermark in the past: deletion bounded by the watermark, not the cutoff', async () => {
    const db = await bootReal()
    try {
      await insertHrv(db, 100)
      await insertHrv(db, 95)
      await insertHrv(db, 1)
      const watermark = new Date(Date.now() - 97 * DAY_MS)

      await runRetentionSweep(db, 'memory', {
        effectiveDays: 90,
        mode: 'r2',
        getPushWatermark: async table => (table === 'hrv' ? watermark : null),
      })

      // Bound = LEAST(now-90d, now-97d) = now-97d → only the 100d row goes;
      // the 95d row is past retention but NOT yet pushed → preserved.
      expect(await count(db, 'hrv')).toBe(2)
    }
    finally {
      await db.close()
    }
  })

  it('r2 mode, watermark ahead of the cutoff: retention cutoff governs', async () => {
    const db = await bootReal()
    try {
      await insertHrv(db, 100)
      await insertHrv(db, 95)
      await insertHrv(db, 1)
      const watermark = new Date() // everything pushed

      await runRetentionSweep(db, 'memory', {
        effectiveDays: 90,
        mode: 'r2',
        getPushWatermark: async table => (table === 'hrv' ? watermark : null),
      })

      expect(await count(db, 'hrv')).toBe(1) // 100d + 95d aged out, 1d kept
    }
    finally {
      await db.close()
    }
  })

  it('local mode: plain retention cutoff applies without any watermark', async () => {
    const db = await bootReal()
    try {
      await insertHrv(db, 100)
      await insertHrv(db, 1)
      await db.execute(
        `INSERT INTO memory.insight (insight_id, ts, brand, family_id, user_id, metric, kind, severity, title)
         VALUES ('i1', now() - INTERVAL '100 days', 'b', 'f', 'u', 'hrv_ms', 'threshold', 'warn', 't')`,
      )

      const result = await runRetentionSweep(db, 'memory', {
        effectiveDays: 90,
        mode: 'local',
      })

      expect(await count(db, 'hrv')).toBe(1)
      expect(await count(db, 'insight')).toBe(0) // fixed 90d, unguarded in local mode
      expect(result.skipped).toEqual([])
    }
    finally {
      await db.close()
    }
  })
})
