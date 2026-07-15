import { describe, expect, it } from 'vitest'
import { createFakeEngine } from '../__fakes__/engine'
import { getInsights } from '../impls/insights'

const baseCtx = {
  requesterUserId: 'alice',
  brand: 'zivaone',
  familyId: 'fam-1',
}

describe('getInsights', () => {
  it('formats bulleted list with severity prefix', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM insight', [
      {
        id: 'i-1',
        ts: '2026-07-10 08:00:00',
        severity: 'warn',
        title: 'HRV below baseline',
        body: '3-day drop of 15%',
      },
      {
        id: 'i-2',
        ts: '2026-07-09 22:00:00',
        severity: 'info',
        title: 'Sleep goal met',
        body: null,
      },
    ])

    const res = await getInsights(
      { userId: 'alice', days: 7 },
      { ...baseCtx, analytics: engine },
    )

    expect(res.rowCount).toBe(2)
    expect(res.text).toContain('Insights, last 7 days')
    expect(res.text).toContain(
      '[warn] 2026-07-10 08:00:00: HRV below baseline — 3-day drop of 15%',
    )
    expect(res.text).toContain('[info] 2026-07-09 22:00:00: Sleep goal met')
  })

  it('threads severity filter into params + SQL', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM insight', [])
    await getInsights(
      { userId: 'alice', days: 7, severity: 'critical' },
      { ...baseCtx, analytics: engine },
    )
    expect(engine.calls[0].sql).toContain('severity = $severity')
    expect(engine.calls[0].params.severity).toBe('critical')
  })

  it('handles empty result with severity in message', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM insight', [])
    const res = await getInsights(
      { userId: 'alice', days: 7, severity: 'critical' },
      { ...baseCtx, analytics: engine },
    )
    expect(res.text).toContain('No insights (critical) in the last 7 days')
    expect(res.rowCount).toBe(0)
  })
})
