/*
 * Per-metric baselines: the bounded form returns exactly the view form's
 * percentiles, for every metric that reads a clean view, every window, at
 * several clocks and zones and on the real `now()` — and a bound too tight is
 * caught (mongrov-packages#44). Harness, fixture and method:
 * `setup/bounded-readers.ts`.
 *
 * 93 days of fixture, so the 90-day scan (`windowDays + 1` days back, plus the
 * spare day) starts inside the data and its lower bound is exercised.
 */
import { describe, expect, it } from 'vitest'
import { BOUNDED_BASELINE_METRICS, CLOCK_MINUTES, clockAt, compareBaselines, open, tally, tighten } from '../setup/bounded-readers'

const DAYS = 93

describe('bounded readers: per-metric baselines (mongrov-packages#44)', () => {
  it('covers every vital baseline, and not steps or sleep', () => {
    expect([...BOUNDED_BASELINE_METRICS].sort()).toEqual(
      ['hr_bpm', 'hrv_ms', 'resting_gated_avg', 'resting_hr', 'spo2', 'stress', 'temp_c'],
    )
  })

  it('bounded == view, at every clock and zone, and on the real now()', async () => {
    const db = await open({ days: DAYS })
    const t = tally()
    for (const m of CLOCK_MINUTES.slice(0, 3)) await compareBaselines(db, clockAt(m), t)
    expect(t.differ).toEqual([])
    // Non-vacuous: every metric produced a baseline in its 30- and 90-day windows.
    for (const metric of BOUNDED_BASELINE_METRICS) {
      expect(t.nonEmpty.has(`${metric}/30`)).toBe(true)
      expect(t.nonEmpty.has(`${metric}/90`)).toBe(true)
    }
    await db.close()

    const now = Math.floor(Date.now() / 60_000) * 60_000
    const live = await open({ days: DAYS, origin: now - DAYS * 86_400_000 - 13 * 60_000 })
    const l = tally()
    await compareBaselines(live, undefined, l, { windows: [30, 90], zones: ['UTC', 'Asia/Kolkata'] })
    expect(l.differ).toEqual([])
    expect(l.nonEmpty.size).toBeGreaterThan(0)
    await live.close()
  }, 600_000)

  it('MUTATION: a lower bound two days inside the scan is caught', async () => {
    // 48h: the scan is a spare day wider than the kept days by design, so a
    // smaller cut changes nothing — correctly.
    const db = await open({ days: DAYS })
    const t = tally()
    await compareBaselines(db, clockAt(CLOCK_MINUTES[1]!), t, { mutate: s => tighten(s, 48), windows: [7, 30], zones: ['UTC'] })
    expect(t.differIds.size).toBeGreaterThan(0)
    await db.close()
  }, 600_000)
})
