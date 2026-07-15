import { describe, expect, it } from 'vitest'
import { createFakeEngine } from '../__fakes__/engine'
import { compareTrend } from '../impls/compare'

const baseCtx = {
  requesterUserId: 'alice',
  brand: 'zivaone',
  familyId: 'fam-1',
}

describe('compareTrend', () => {
  it('renders current vs prior HRV window with delta', async () => {
    const engine = createFakeEngine()
    // Both queries hit the hrv table; first match wins per queue order.
    engine.queueRows('FROM hrv', [{ value: 44.9 }])
    engine.queueRows('FROM hrv', [{ value: 47.2 }])

    const res = await compareTrend(
      {
        userId: 'alice',
        metric: 'hrv_ms',
        currentWindowDays: 7,
        priorWindowDays: 7,
      },
      { ...baseCtx, analytics: engine },
    )

    expect(res.rowCount).toBe(2)
    expect(res.text).toContain('current 7d: 44.9ms')
    expect(res.text).toContain('prior 7d:   47.2ms')
    expect(res.text).toContain('delta: -4.9%')
  })

  it('dispatches to sleep_session for sleep metric', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM sleep_session', [{ value: 420 }])
    engine.queueRows('FROM sleep_session', [{ value: 400 }])
    const res = await compareTrend(
      {
        userId: 'alice',
        metric: 'sleep_total_minutes',
        currentWindowDays: 7,
        priorWindowDays: 7,
      },
      { ...baseCtx, analytics: engine },
    )
    expect(res.text).toContain('sleep total trend')
    expect(res.text).toContain('current 7d: 420.0min')
    expect(res.text).toContain('delta: +5.0%')
  })

  it('handles both windows empty', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM hrv', [])
    engine.queueRows('FROM hrv', [])
    const res = await compareTrend(
      {
        userId: 'alice',
        metric: 'hrv_ms',
        currentWindowDays: 7,
        priorWindowDays: 7,
      },
      { ...baseCtx, analytics: engine },
    )
    expect(res.text).toContain('Insufficient HRV data')
    expect(res.rowCount).toBe(0)
  })

  it('handles current present, prior missing', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM hrv', [{ value: 50 }])
    engine.queueRows('FROM hrv', [])
    const res = await compareTrend(
      {
        userId: 'alice',
        metric: 'hrv_ms',
        currentWindowDays: 7,
        priorWindowDays: 7,
      },
      { ...baseCtx, analytics: engine },
    )
    expect(res.text).toContain('current 7d: 50.0ms')
    expect(res.text).toContain('prior 7d:   n/ams')
    expect(res.text).toContain('delta: n/a')
  })
})
