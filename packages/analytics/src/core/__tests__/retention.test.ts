import { describe, expect, it } from 'vitest'

import { AnalyticsError } from '../errors'
import { HybridDuckDB } from '../engine'
import {
  AUDIT_RETENTION_DAYS,
  buildDeleteSql,
  INSIGHT_RETENTION_DAYS,
  resolveEffectiveRetention,
  runRetentionSweep,
} from '../retention'

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
  it('emits catalog-qualified LEAST with sync_watermark subquery', () => {
    const sql = buildDeleteSql({
      catalog: 'zone_fam123',
      table: 'hrv',
      tsCol: 'ts',
      days: 90,
    })
    expect(sql).toContain('DELETE FROM zone_fam123.hrv')
    expect(sql).toContain('ts < LEAST(')
    expect(sql).toContain(`now() - INTERVAL '90 days'`)
    expect(sql).toContain(
      `(SELECT MAX(cursor_ts) FROM zone_fam123.sync_watermark WHERE table_name = 'hrv')`,
    )
  })

  it('respects a non-default ts column (sleep_session uses ts_end)', () => {
    const sql = buildDeleteSql({
      catalog: 'zone_x',
      table: 'sleep_session',
      tsCol: 'ts_end',
      days: 60,
    })
    expect(sql).toContain('ts_end < LEAST(')
    expect(sql).toContain(`INTERVAL '60 days'`)
  })
})

describe('runRetentionSweep', () => {
  it('issues one DELETE per retention-managed table (skips device_config + sync_watermark)', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()
    const openCalls = fake.calls.length

    const result = await runRetentionSweep(db, 'zone_fam123', { effectiveDays: 90 })
    const deletes = fake.calls.slice(openCalls).filter(c => c.sql.startsWith('DELETE FROM'))

    // 15 tables total in SCHEMAS; device_config + sync_watermark skipped → 13 DELETEs.
    expect(deletes).toHaveLength(13)
    expect(result.swept).toHaveLength(13)
    const swept = new Set(result.swept.map(e => e.table))
    expect(swept.has('device_config')).toBe(false)
    expect(swept.has('sync_watermark')).toBe(false)
    expect(swept.has('hrv')).toBe(true)
    expect(swept.has('insight')).toBe(true)
    expect(swept.has('tool_call_audit')).toBe(true)
  })

  it('uses fixed 90d for insight and 30d for tool_call_audit', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()

    const result = await runRetentionSweep(db, 'zone_x', { effectiveDays: 180 })
    const insight = result.swept.find(e => e.table === 'insight')
    const audit = result.swept.find(e => e.table === 'tool_call_audit')
    const hrv = result.swept.find(e => e.table === 'hrv')
    expect(insight?.days).toBe(INSIGHT_RETENTION_DAYS)
    expect(audit?.days).toBe(AUDIT_RETENTION_DAYS)
    expect(hrv?.days).toBe(180)
  })

  it('wraps engine failures in AnalyticsError with retention_failed code', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()

    fake.failNextExecute(new Error('disk full'))

    await expect(
      runRetentionSweep(db, 'zone_x', { effectiveDays: 90 }),
    ).rejects.toMatchObject({
      name: 'AnalyticsError',
      code: 'retention_failed',
    })

    // Same call, second invocation — no scripted failure — succeeds.
    await expect(
      runRetentionSweep(db, 'zone_x', { effectiveDays: 90 }),
    ).resolves.toBeDefined()
  })

  it('sensor-table DELETE bounded by push watermark (safe when no watermark)', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()
    const openCalls = fake.calls.length

    await runRetentionSweep(db, 'zone_fam123', { effectiveDays: 90 })
    const hrvDelete = fake.calls.slice(openCalls).find(
      c => c.sql.startsWith('DELETE FROM zone_fam123.hrv'),
    )
    expect(hrvDelete).toBeDefined()
    // Guard clause: without a watermark, LEAST() returns NULL and
    // `ts < NULL` is false → no row deleted. Assert the shape survives.
    expect(hrvDelete?.sql).toContain(
      `(SELECT MAX(cursor_ts) FROM zone_fam123.sync_watermark WHERE table_name = 'hrv')`,
    )
  })
})
