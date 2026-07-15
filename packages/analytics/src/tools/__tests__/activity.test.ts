import { describe, expect, it } from 'vitest'
import { createFakeEngine } from '../__fakes__/engine'
import { getActivityTotal } from '../impls/activity'

const baseCtx = {
  requesterUserId: 'alice',
  brand: 'zivaone',
  familyId: 'fam-1',
}

describe('getActivityTotal', () => {
  it('joins steps + buckets by day and reports totals', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM activity\n', [
      { day: '2026-07-08', steps: 8000 },
      { day: '2026-07-09', steps: 10000 },
    ])
    engine.queueRows('FROM activity_bucket', [
      { day: '2026-07-08', calories: 400, distance_km: 6.5 },
      { day: '2026-07-09', calories: 520, distance_km: 8.1 },
    ])

    const res = await getActivityTotal(
      { userId: 'alice', days: 2 },
      { ...baseCtx, analytics: engine },
    )

    expect(res.rowCount).toBe(2)
    expect(res.text).toContain('Activity, last 2 days')
    expect(res.text).toContain('2026-07-08: 8000 steps, 400 kcal, 6.50 km')
    expect(res.text).toContain('2026-07-09: 10000 steps, 520 kcal, 8.10 km')
    expect(res.text).toContain('Totals: 18000 steps, 920 kcal, 14.60 km')
  })

  it('handles days where only steps are present', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM activity\n', [
      { day: '2026-07-08', steps: 5000 },
    ])
    engine.queueRows('FROM activity_bucket', [])
    const res = await getActivityTotal(
      { userId: 'alice', days: 1 },
      { ...baseCtx, analytics: engine },
    )
    expect(res.text).toContain('2026-07-08: 5000 steps')
    expect(res.text).toContain('Totals: 5000 steps, 0 kcal, 0.00 km')
  })

  it('handles empty result', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM activity\n', [])
    engine.queueRows('FROM activity_bucket', [])
    const res = await getActivityTotal(
      { userId: 'alice', days: 7 },
      { ...baseCtx, analytics: engine },
    )
    expect(res.text).toContain('No activity data')
    expect(res.rowCount).toBe(0)
  })
})
