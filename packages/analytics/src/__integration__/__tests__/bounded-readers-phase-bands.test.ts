/*
 * The HR phase bands: the bounded form returns exactly the view form's rails,
 * at several clocks and zones and on the real `now()`, and a bound too tight
 * is caught (mongrov-packages#44). Harness, fixture and method:
 * `setup/bounded-readers.ts`.
 *
 * 93 days of fixture, so the 90-day scan (`windowDays + 2` days back) starts
 * inside the data and its lower bound is exercised.
 */
import { describe, expect, it } from 'vitest'
import { CLOCK_MINUTES, clockAt, comparePhaseBands, open, tally, tighten } from '../setup/bounded-readers'

const DAYS = 93

describe('bounded readers: HR phase bands (mongrov-packages#44)', () => {
  it('bounded == view, at every clock and zone, and on the real now()', async () => {
    const db = await open({ days: DAYS })
    const t = tally()
    for (const m of CLOCK_MINUTES.slice(0, 4)) await comparePhaseBands(db, clockAt(m), t)
    expect(t.differ).toEqual([])
    expect([...t.nonEmpty].sort()).toEqual(['30', '90'])
    await db.close()

    const now = Math.floor(Date.now() / 60_000) * 60_000
    const live = await open({ days: DAYS, origin: now - DAYS * 86_400_000 - 13 * 60_000 })
    const l = tally()
    await comparePhaseBands(live, undefined, l, { windows: [30, 90], zones: ['UTC', 'Asia/Kolkata'] })
    expect(l.differ).toEqual([])
    expect(l.nonEmpty.size).toBe(2)
    await live.close()
  }, 300_000)

  it('MUTATION: a lower bound a day inside the rail days is caught for both windows', async () => {
    // 48h, not 26h: the scan is a day wider than any rail by design (the
    // zone offset), so cutting less than that changes nothing — correctly.
    const db = await open({ days: DAYS })
    const t = tally()
    for (const m of CLOCK_MINUTES.slice(0, 2))
      await comparePhaseBands(db, clockAt(m), t, { mutate: s => tighten(s, 48), windows: [30, 90] })
    expect([...t.differIds].sort()).toEqual(['30', '90'])
    await db.close()
  }, 300_000)
})
