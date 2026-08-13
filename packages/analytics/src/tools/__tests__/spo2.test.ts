/**
 * Sprint 5 T-30 / T-33 — `getSpO2` implementation + registration.
 */

import { describe, expect, it } from 'vitest'

import { createFakeEngine } from '../__fakes__/engine'
import { createAnalyticsTools } from '../factory'
import { getSpO2, LOW_MOMENT_THRESHOLD } from '../impls/spo2'

const CTX = { brand: 'ziva', familyId: 'fam1', requesterUserId: 'alice' } as never

describe('getSpO2 query shape', () => {
  it('scopes to sleep via an INNER JOIN on v_sleep_session', async () => {
    // "How was my oxygen last night?" means during sleep — averaging
    // around the clock would wash out the dips the question is about.
    const engine = createFakeEngine()
    engine.queueRows('FROM v_spo2', [])
    await getSpO2({ userId: 'alice', days: 1 }, { analytics: engine, ...CTX } as never)

    const sql = engine.calls[0].sql
    expect(sql).toContain('FROM v_spo2 m')
    expect(sql).toContain('INNER JOIN v_sleep_session s')
    expect(sql).toContain('m.ts BETWEEN s.ts_start AND s.ts_end')
  })

  it('groups by night_of, not calendar day', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM v_spo2', [])
    await getSpO2({ userId: 'alice', days: 7 }, { analytics: engine, ...CTX } as never)
    expect(engine.calls[0].sql).toContain('GROUP BY s.night_of')
  })

  it('counts low moments at the documented threshold', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM v_spo2', [])
    await getSpO2({ userId: 'alice', days: 1 }, { analytics: engine, ...CTX } as never)
    expect(engine.calls[0].sql).toContain(`m.spo2 < ${LOW_MOMENT_THRESHOLD}`)
  })

  it('binds tenant params, never inlines them', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM v_spo2', [])
    await getSpO2({ userId: 'alice', days: 1 }, { analytics: engine, ...CTX } as never)
    expect(engine.calls[0].params).toMatchObject({
      userId: 'alice',
      brand: 'ziva',
      familyId: 'fam1',
      days: 1,
    })
  })

  it('reads the shared user_baseline for the reference range', async () => {
    // Same table the chart's "usual range" band reads, so narrative and
    // chart cannot disagree.
    const engine = createFakeEngine()
    engine.queueRows('FROM v_spo2', [
      { night_of: '2026-07-01', avg_spo2: 96, min_spo2: 88, low_moment_count: 2 },
    ])
    engine.queueRows('FROM user_baseline', [
      { p05: 93, p10: 94, p50: 96, computed_at: '2026-07-02T00:00:00Z' },
    ])
    const out = await getSpO2({ userId: 'alice', days: 1 }, { analytics: engine, ...CTX } as never)

    expect(engine.calls[1].sql).toContain('FROM user_baseline')
    expect(engine.calls[1].sql).toContain(`metric = 'spo2'`)
    expect(out.text).toContain('usual range')
  })

  it('degrades to "still learning" with no mature baseline', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM v_spo2', [
      { night_of: '2026-07-01', avg_spo2: 96, min_spo2: 88, low_moment_count: 0 },
    ])
    engine.queueRows('FROM user_baseline', [])
    const out = await getSpO2({ userId: 'alice', days: 1 }, { analytics: engine, ...CTX } as never)
    expect(out.text).toContain('Still learning')
  })

  it('reports rowCount + bytes like every other tool', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM v_spo2', [
      { night_of: '2026-07-01', avg_spo2: 96, min_spo2: 88, low_moment_count: 1 },
      { night_of: '2026-07-02', avg_spo2: 95, min_spo2: 90, low_moment_count: 0 },
    ])
    engine.queueRows('FROM user_baseline', [])
    const out = await getSpO2({ userId: 'alice', days: 2 }, { analytics: engine, ...CTX } as never)
    expect(out.rowCount).toBe(2)
    expect(out.bytes).toBeGreaterThan(0)
  })
})

describe('T-33 — registered in the tool factory', () => {
  it('is present with a description and schema', () => {
    const engine = createFakeEngine()
    const handle = createAnalyticsTools({ analytics: engine as never })
    const tool = (handle.tools as Record<string, { description?: string, execute?: unknown }>).getSpO2
    expect(tool).toBeDefined()
    expect(typeof tool.description).toBe('string')
    expect(typeof tool.execute).toBe('function')
  })

  it('description avoids clinical vocabulary too', async () => {
    // The description also lands in the model's context.
    const { findBanTerms } = await import('../formatters')
    const engine = createFakeEngine()
    const handle = createAnalyticsTools({ analytics: engine as never })
    for (const [name, tool] of Object.entries(handle.tools as Record<string, { description?: string }>)) {
      expect(findBanTerms(tool.description ?? ''), `${name} description`).toEqual([])
    }
  })
})
