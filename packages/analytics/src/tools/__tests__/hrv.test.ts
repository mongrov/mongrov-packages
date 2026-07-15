import { describe, expect, it } from 'vitest'
import { createFakeEngine } from '../__fakes__/engine'
import { getHRV } from '../impls/hrv'

const baseCtx = {
  requesterUserId: 'alice',
  brand: 'zivaone',
  familyId: 'fam-1',
}

describe('getHRV', () => {
  it('formats window with per-day values and baseline delta', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM hrv', [
      { day: '2026-07-08', avg_hrv: 45 },
      { day: '2026-07-09', avg_hrv: 42 },
      { day: '2026-07-10', avg_hrv: 51 },
    ])

    const res = await getHRV(
      { userId: 'alice', days: 3 },
      { ...baseCtx, analytics: engine },
    )

    expect(res.rowCount).toBe(3)
    expect(res.bytes).toBeGreaterThan(0)
    expect(res.text).toContain('HRV, last 3 days')
    expect(res.text).toContain('2026-07-08: 45.0ms')
    expect(res.text).toContain('2026-07-10: 51.0ms')
    expect(res.text).toContain('3-day avg: 46.0ms')
    // latest (51) is +10.9% vs avg (46)
    expect(res.text).toContain('+10.9% vs avg')
  })

  it('binds userId, brand, familyId, days params', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM hrv', [])
    await getHRV(
      { userId: 'bob', days: 14 },
      { ...baseCtx, analytics: engine },
    )
    expect(engine.calls[0].params).toEqual({
      userId: 'bob',
      brand: 'zivaone',
      familyId: 'fam-1',
      days: 14,
    })
  })

  it('handles empty result', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM hrv', [])
    const res = await getHRV(
      { userId: 'alice', days: 7 },
      { ...baseCtx, analytics: engine },
    )
    expect(res.text).toContain('No HRV data')
    expect(res.rowCount).toBe(0)
  })
})
