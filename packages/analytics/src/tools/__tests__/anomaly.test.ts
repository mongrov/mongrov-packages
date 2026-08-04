import { describe, expect, it } from 'vitest'
import { createFakeEngine } from '../__fakes__/engine'
import { detectAnomaly } from '../impls/anomaly'

const baseCtx = {
  requesterUserId: 'alice',
  brand: 'zivaone',
  familyId: 'fam-1',
}

describe('detectAnomaly', () => {
  it('flags days > threshold * stddev from mean', async () => {
    const engine = createFakeEngine()
    // Baseline 45 ± ~1.5, planted 60 as clear outlier.
    engine.queueRows('FROM v_hrv', [
      { day: '2026-07-01', value: 45 },
      { day: '2026-07-02', value: 46 },
      { day: '2026-07-03', value: 44 },
      { day: '2026-07-04', value: 47 },
      { day: '2026-07-05', value: 45 },
      { day: '2026-07-06', value: 46 },
      { day: '2026-07-07', value: 60 }, // outlier
    ])

    const res = await detectAnomaly(
      {
        userId: 'alice',
        metric: 'hrv_ms',
        lookbackDays: 7,
        stddevThreshold: 2,
      },
      { ...baseCtx, analytics: engine },
    )

    expect(res.rowCount).toBe(1)
    expect(res.text).toContain('HRV anomalies')
    expect(res.text).toContain('threshold 2σ')
    expect(res.text).toContain('2026-07-07: 60.0ms')
  })

  it('reports no outliers when data is flat', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM v_hrv', [
      { day: '2026-07-01', value: 45 },
      { day: '2026-07-02', value: 45 },
      { day: '2026-07-03', value: 45 },
      { day: '2026-07-04', value: 45 },
      { day: '2026-07-05', value: 45 },
      { day: '2026-07-06', value: 45 },
      { day: '2026-07-07', value: 45 },
    ])
    const res = await detectAnomaly(
      {
        userId: 'alice',
        metric: 'hrv_ms',
        lookbackDays: 7,
        stddevThreshold: 2,
      },
      { ...baseCtx, analytics: engine },
    )
    expect(res.rowCount).toBe(0)
    expect(res.text).toContain('No outliers detected')
  })

  it('handles empty result', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM v_sleep_session', [])
    const res = await detectAnomaly(
      {
        userId: 'alice',
        metric: 'sleep_total_minutes',
        lookbackDays: 14,
        stddevThreshold: 2,
      },
      { ...baseCtx, analytics: engine },
    )
    expect(res.text).toContain('No sleep total data')
    expect(res.rowCount).toBe(0)
  })
})
