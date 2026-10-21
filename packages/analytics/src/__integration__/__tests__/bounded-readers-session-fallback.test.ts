/*
 * Two conditions production should never be in, where the answers must
 * still agree (mongrov-packages#44):
 *
 *   - the session zone is not UTC (`bootstrapExtensions` pins it; if that
 *     pin were lost, `ts > NOW() - x` reads a naive `ts` in the session zone,
 *     up to 14 hours either way — the spare day must cover it);
 *   - every macro is the plain stand-in `createViews` installs when a real
 *     body fails at attach.
 *
 * Harness, fixture and method: `setup/bounded-readers.ts`.
 */
import { describe, expect, it } from 'vitest'
import { fallbackMacroDdl, qualityMacroDdls } from '../../core/reading-quality'
import { BOUNDED_RULES, CLOCK_MINUTES, clockAt, comparePhaseBands, compareRules, compareTools, open, tally } from '../setup/bounded-readers'

describe('bounded readers: off-nominal sessions (mongrov-packages#44)', () => {
  it('the spare day covers a session zone that is not UTC', async () => {
    const db = await open()
    for (const zone of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
      await db.execute(`SET TimeZone='${zone}';`)
      const t = tally()
      await compareRules(db, BOUNDED_RULES, clockAt(CLOCK_MINUTES[3]!), t, { extremesOnly: true })
      await compareTools(db, clockAt(CLOCK_MINUTES[3]!), t)
      expect({ zone, differ: t.differ }).toEqual({ zone, differ: [] })
    }
    await db.close()
  }, 300_000)

  it('the plain stand-in macros give the same answers too', async () => {
    const db = await open()
    for (const m of qualityMacroDdls()) await db.execute(fallbackMacroDdl(m.name))
    const t = tally()
    const clock = clockAt(CLOCK_MINUTES[1]!)
    await compareRules(db, BOUNDED_RULES, clock, t, { extremesOnly: true })
    await comparePhaseBands(db, clock, t)
    await compareTools(db, clock, t)
    expect(t.differ).toEqual([])
    await db.close()
  }, 300_000)
})
