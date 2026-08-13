import type { ToolContext } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeEngine } from '../__fakes__/engine'
import { createAnalyticsTools } from '../factory'

const baseCtx: ToolContext = {
  requesterUserId: 'alice',
  brand: 'zivaone',
  familyId: 'fam-1',
}

describe('createAnalyticsTools', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns seven AI SDK tools with description + parameters + execute', () => {
    const engine = createFakeEngine()
    const handle = createAnalyticsTools({ analytics: engine })
    const names = Object.keys(handle.tools).sort()
    expect(names).toEqual([
      'compareTrend',
      'detectAnomaly',
      'getActivityTotal',
      'getHRV',
      'getInsights',
      'getSleepSummary',
      'getSpO2',
    ])
    for (const name of names) {
      const t = (handle.tools as Record<string, unknown>)[name] as {
        description?: string
        parameters?: unknown
        execute?: unknown
      }
      expect(typeof t.description).toBe('string')
      expect(t.parameters).toBeDefined()
      expect(typeof t.execute).toBe('function')
    }
  })

  it('end-to-end: setContext + invoke getHRV writes audit success row', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM v_hrv', [
      { day: '2026-07-10', avg_hrv: 42.5 },
      { day: '2026-07-11', avg_hrv: 44.0 },
    ])
    const handle = createAnalyticsTools({
      analytics: engine,
      rateLimit: false,
      audit: { batchSize: 1 },
    })
    handle.setContext(baseCtx)
    const out = await handle.tools.getHRV.execute!(
      { userId: 'alice', days: 7 },
      {} as any,
    )
    expect(typeof out).toBe('string')
    expect(out as string).toContain('HRV')
    // Wait for audit auto-flush (batchSize:1 triggers immediately).
    await vi.waitFor(() => {
      const auditCalls = engine.calls.filter(c =>
        c.sql.includes('INSERT INTO tool_call_audit'),
      )
      expect(auditCalls).toHaveLength(1)
    })
    await handle.close()
  })

  it('invocation without setContext returns error string + audits error row', async () => {
    const engine = createFakeEngine()
    const handle = createAnalyticsTools({
      analytics: engine,
      rateLimit: false,
      audit: { batchSize: 1 },
    })
    const out = await handle.tools.getHRV.execute!(
      { userId: 'alice', days: 7 },
      {} as any,
    )
    expect(out as string).toContain('context not set')
    await vi.waitFor(() => {
      const auditCalls = engine.calls.filter(c =>
        c.sql.includes('INSERT INTO tool_call_audit'),
      )
      expect(auditCalls).toHaveLength(1)
      expect(auditCalls[0].params.p0_outcome).toBe('error')
      expect(auditCalls[0].params.p0_error_message).toBe('context not set')
    })
    await handle.close()
  })

  it('familyMembersProvider bypasses SQL for authorize', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM v_hrv', [{ day: '2026-07-10', avg_hrv: 42.5 }])
    const provider = vi.fn(async () => ['alice', 'bob'])
    const handle = createAnalyticsTools({
      analytics: engine,
      rateLimit: false,
      audit: { enabled: false },
      familyMembersProvider: provider,
    })
    handle.setContext(baseCtx)
    await handle.tools.getHRV.execute!(
      { userId: 'bob', days: 7 },
      {} as any,
    )
    expect(provider).toHaveBeenCalledWith({ brand: 'zivaone', familyId: 'fam-1' })
    // No SQL against family_member should have run (only the HRV query).
    const familyMemberCalls = engine.calls.filter(c =>
      c.sql.includes('FROM family_member'),
    )
    expect(familyMemberCalls).toHaveLength(0)
    await handle.close()
  })

  it('rateLimit: false disables limiter entirely (unlimited invocations)', async () => {
    const engine = createFakeEngine()
    for (let i = 0; i < 50; i++) {
      engine.queueRows('FROM v_hrv', [{ day: '2026-07-10', avg_hrv: 42.5 }])
    }
    const handle = createAnalyticsTools({
      analytics: engine,
      rateLimit: false,
      audit: { enabled: false },
    })
    handle.setContext(baseCtx)
    const results = await Promise.all(
      Array.from({ length: 50 }, () => handle.tools.getHRV.execute!({ userId: 'alice', days: 7 }, {} as any)),
    )
    // None should contain the rate-limit sentinel.
    for (const r of results) {
      expect(r as string).not.toContain('Rate limit')
    }
    await handle.close()
  })

  it('audit.enabled: false suppresses all INSERTs', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM v_hrv', [{ day: '2026-07-10', avg_hrv: 42.5 }])
    const handle = createAnalyticsTools({
      analytics: engine,
      rateLimit: false,
      audit: { enabled: false },
    })
    handle.setContext(baseCtx)
    await handle.tools.getHRV.execute!(
      { userId: 'alice', days: 7 },
      {} as any,
    )
    const auditCalls = engine.calls.filter(c =>
      c.sql.includes('INSERT INTO tool_call_audit'),
    )
    expect(auditCalls).toHaveLength(0)
    await handle.close()
  })

  it('custom authorize hook is used when supplied', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM v_hrv', [{ day: '2026-07-10', avg_hrv: 42.5 }])
    const authorize = vi.fn(async () => false)
    const handle = createAnalyticsTools({
      analytics: engine,
      rateLimit: false,
      audit: { enabled: false },
      authorize,
    })
    handle.setContext(baseCtx)
    const out = await handle.tools.getHRV.execute!(
      { userId: 'bob', days: 7 },
      {} as any,
    )
    expect(out as string).toContain('Not authorized')
    expect(authorize).toHaveBeenCalledWith(
      'getHRV',
      { userId: 'bob', days: 7 },
      baseCtx,
    )
  })

  it('close() flushes pending audit and stops the timer', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM v_hrv', [{ day: '2026-07-10', avg_hrv: 42.5 }])
    const handle = createAnalyticsTools({
      analytics: engine,
      rateLimit: false,
      audit: { batchSize: 100, flushIntervalMs: 5000 },
    })
    handle.setContext(baseCtx)
    await handle.tools.getHRV.execute!(
      { userId: 'alice', days: 7 },
      {} as any,
    )
    // batchSize is 100 so nothing has flushed.
    let auditCalls = engine.calls.filter(c =>
      c.sql.includes('INSERT INTO tool_call_audit'),
    )
    expect(auditCalls).toHaveLength(0)
    await handle.close()
    auditCalls = engine.calls.filter(c =>
      c.sql.includes('INSERT INTO tool_call_audit'),
    )
    expect(auditCalls).toHaveLength(1)
    // Timer no longer fires.
    await vi.advanceTimersByTimeAsync(10_000)
    auditCalls = engine.calls.filter(c =>
      c.sql.includes('INSERT INTO tool_call_audit'),
    )
    expect(auditCalls).toHaveLength(1)
  })
})
