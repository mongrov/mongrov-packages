import { describe, expect, it } from 'vitest'
import { createFakeEngine } from '../__fakes__/engine'
import { getSleepSummary } from '../impls/sleep'

const baseCtx = {
  requesterUserId: 'alice',
  brand: 'zivaone',
  familyId: 'fam-1',
}

describe('getSleepSummary', () => {
  it('formats per-night totals + stages + trend', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM sleep_session', [
      {
        night_of: '2026-07-08',
        total_minutes: 420,
        deep_minutes: 90,
        rem_minutes: 100,
        light_minutes: 230,
      },
      {
        night_of: '2026-07-09',
        total_minutes: 400,
        deep_minutes: 80,
        rem_minutes: 95,
        light_minutes: 225,
      },
    ])

    const res = await getSleepSummary(
      { userId: 'alice', days: 2 },
      { ...baseCtx, analytics: engine },
    )

    expect(res.rowCount).toBe(2)
    expect(res.text).toContain('Sleep, last 2 days')
    expect(res.text).toContain('2026-07-08: 420m total, 90m deep, 100m REM')
    expect(res.text).toContain('2026-07-09: 400m total')
    expect(res.text).toContain('2-night avg total: 410m')
  })

  it('handles rows without stage data', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM sleep_session', [
      {
        night_of: '2026-07-08',
        total_minutes: 420,
        deep_minutes: null,
        rem_minutes: null,
        light_minutes: null,
      },
    ])
    const res = await getSleepSummary(
      { userId: 'alice', days: 1 },
      { ...baseCtx, analytics: engine },
    )
    expect(res.text).toContain('2026-07-08: 420m total')
    expect(res.text).not.toContain('deep')
    expect(res.text).not.toContain('REM')
  })

  it('handles empty result', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM sleep_session', [])
    const res = await getSleepSummary(
      { userId: 'alice', days: 7 },
      { ...baseCtx, analytics: engine },
    )
    expect(res.text).toContain('No sleep sessions')
    expect(res.rowCount).toBe(0)
  })
})
