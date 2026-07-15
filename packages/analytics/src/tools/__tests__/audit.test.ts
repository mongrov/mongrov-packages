import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeEngine } from '../__fakes__/engine'
import { createAuditWriter } from '../audit'
import type { AuditEntry } from '../types'

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: new Date('2026-07-15T10:00:00Z'),
    brand: 'zivaone',
    familyId: 'fam-1',
    requesterUserId: 'alice',
    toolName: 'getHRV',
    args: { userId: 'alice', days: 7 },
    resultBytes: 512,
    resultRowCount: 7,
    latencyMs: 42,
    outcome: 'success',
    errorMessage: null,
    ...overrides,
  }
}

describe('createAuditWriter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('enabled:false makes record a no-op', async () => {
    const engine = createFakeEngine()
    const writer = createAuditWriter({ analytics: engine, enabled: false })
    writer.record(makeEntry())
    writer.record(makeEntry())
    await writer.flush()
    expect(engine.calls).toHaveLength(0)
  })

  it('auto-flushes when queue reaches batchSize', async () => {
    const engine = createFakeEngine()
    const writer = createAuditWriter({
      analytics: engine,
      batchSize: 3,
    })
    writer.record(makeEntry())
    writer.record(makeEntry())
    expect(engine.calls).toHaveLength(0)
    writer.record(makeEntry())
    // Batch trigger scheduled the flush; await one microtask cycle.
    await vi.waitFor(() => {
      expect(engine.calls).toHaveLength(1)
    })
    expect(engine.calls[0].sql).toContain('INSERT INTO tool_call_audit')
  })

  it('timer-flushes after flushIntervalMs even below batchSize', async () => {
    const engine = createFakeEngine()
    const writer = createAuditWriter({
      analytics: engine,
      batchSize: 10,
      flushIntervalMs: 1000,
    })
    writer.record(makeEntry())
    writer.record(makeEntry())
    expect(engine.calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(engine.calls).toHaveLength(1)
  })

  it('record is synchronous (does not return a promise)', () => {
    const engine = createFakeEngine()
    const writer = createAuditWriter({ analytics: engine })
    const result = writer.record(makeEntry())
    expect(result).toBeUndefined()
  })

  it('flush failures retain batch and retry on next tick', async () => {
    const engine = createFakeEngine()
    engine.setError(new Error('warehouse_unavailable'))
    const logs: { level: string, msg: string }[] = []
    const writer = createAuditWriter({
      analytics: engine,
      batchSize: 2,
      logger: {
        debug: () => {},
        info: () => {},
        warn: msg => logs.push({ level: 'warn', msg }),
        error: msg => logs.push({ level: 'error', msg }),
      },
    })
    writer.record(makeEntry())
    writer.record(makeEntry())
    await vi.waitFor(() => {
      expect(logs.some(l => l.level === 'warn')).toBe(true)
    })
    // Batch retained; clear error and retry via flush.
    engine.setError(null)
    await writer.flush()
    expect(engine.calls.length).toBeGreaterThanOrEqual(2) // 1 failed + 1 success
  })

  it('drops batch after MAX_CONSECUTIVE_FAILURES', async () => {
    const engine = createFakeEngine()
    engine.setError(new Error('persistent_failure'))
    const logs: { level: string, msg: string }[] = []
    const writer = createAuditWriter({
      analytics: engine,
      batchSize: 1,
      logger: {
        debug: () => {},
        info: () => {},
        warn: msg => logs.push({ level: 'warn', msg }),
        error: msg => logs.push({ level: 'error', msg }),
      },
    })
    // Trigger 5 flushes by exceeding batchSize 5 times.
    for (let i = 0; i < 5; i++) {
      writer.record(makeEntry())
      await writer.flush()
    }
    expect(logs.some(l => l.level === 'error' && l.msg.includes('cap reached'))).toBe(true)
  })

  it('close flushes pending entries and stops the timer', async () => {
    const engine = createFakeEngine()
    const writer = createAuditWriter({
      analytics: engine,
      batchSize: 100,
      flushIntervalMs: 1000,
    })
    writer.record(makeEntry())
    writer.record(makeEntry())
    await writer.close()
    expect(engine.calls).toHaveLength(1)
    // Timer stopped: advance clock, no additional flush.
    await vi.advanceTimersByTimeAsync(5000)
    expect(engine.calls).toHaveLength(1)
  })

  it('INSERT SQL contains all 11 columns with correct param names', async () => {
    const engine = createFakeEngine()
    const writer = createAuditWriter({ analytics: engine, batchSize: 1 })
    writer.record(makeEntry())
    await vi.waitFor(() => {
      expect(engine.calls).toHaveLength(1)
    })
    const { sql, params } = engine.calls[0]
    expect(sql).toContain('ts, brand, family_id, requester_user_id, tool_name, args, result_bytes, result_row_count, latency_ms, outcome, error_message')
    expect(sql).toContain('$p0_ts')
    expect(sql).toContain('$p0_error_message')
    expect(params).toMatchObject({
      p0_brand: 'zivaone',
      p0_family_id: 'fam-1',
      p0_requester_user_id: 'alice',
      p0_tool_name: 'getHRV',
      p0_args: JSON.stringify({ userId: 'alice', days: 7 }),
      p0_result_bytes: 512,
      p0_result_row_count: 7,
      p0_latency_ms: 42,
      p0_outcome: 'success',
      p0_error_message: null,
    })
  })

  it('batched writes produce multi-row VALUES tuples', async () => {
    const engine = createFakeEngine()
    const writer = createAuditWriter({ analytics: engine, batchSize: 3 })
    writer.record(makeEntry({ toolName: 'getHRV' }))
    writer.record(makeEntry({ toolName: 'getSleepSummary' }))
    writer.record(makeEntry({ toolName: 'getActivityTotal' }))
    await vi.waitFor(() => {
      expect(engine.calls).toHaveLength(1)
    })
    const { sql, params } = engine.calls[0]
    expect(sql).toContain('$p0_ts')
    expect(sql).toContain('$p1_ts')
    expect(sql).toContain('$p2_ts')
    expect(params.p0_tool_name).toBe('getHRV')
    expect(params.p1_tool_name).toBe('getSleepSummary')
    expect(params.p2_tool_name).toBe('getActivityTotal')
  })

  it('serializes args field as JSON string', async () => {
    const engine = createFakeEngine()
    const writer = createAuditWriter({ analytics: engine, batchSize: 1 })
    const args = { userId: 'bob', metric: 'hrv_ms', days: 30, nested: { a: 1 } }
    writer.record(makeEntry({ args }))
    await vi.waitFor(() => {
      expect(engine.calls).toHaveLength(1)
    })
    expect(engine.calls[0].params.p0_args).toBe(JSON.stringify(args))
  })
})
