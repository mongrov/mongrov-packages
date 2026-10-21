/*
 * MUTATION: a bound that is too tight is caught for EVERY reader
 * (mongrov-packages#44).
 *
 * `tighten` moves each bounded `lo` 26 hours later — 2 hours inside the
 * reader's window once the spare day is spent. `seedSentinels` puts
 * extreme readings just inside every window start, one side at a time, so the
 * rows the mutation drops move each aggregate, run, band deviation and day
 * value. Every bounded rule and every tool must then disagree at least once.
 * The phase bands' mutation lives in `bounded-readers-phase-bands.test.ts`.
 *
 * The one exemption is `aggregation: 'last'`: it reads only the newest
 * reading, so no lower bound short of the whole window can change it — a
 * too-tight bound is not a wrong answer there.
 *
 * Harness, fixture and method: `setup/bounded-readers.ts`.
 */
import { describe, expect, it } from 'vitest'
import { BOUNDED_RULES, clockAt, compareRules, compareTools, END, open, seedSentinels, tally, tighten, TOOL_NAMES } from '../setup/bounded-readers'

/** Clocks with a 24h window start inside a night (asleep rules) and outside one. */
const MUTATION_CLOCKS = [0, 151, 7 * 60 + 13, 15 * 60 + 2]

describe('bounded readers: mutation (mongrov-packages#44)', () => {
  it('control: with the sentinels in and the bounds untouched, every reader still agrees', async () => {
    // Otherwise a disagreement below could be the sentinels', not the bound's.
    for (const side of ['low', 'high'] as const) {
      const db = await open()
      await seedSentinels(db, END + MUTATION_CLOCKS[0]! * 60_000, side)
      const t = tally()
      const clock = clockAt(MUTATION_CLOCKS[0]!)
      await compareRules(db, BOUNDED_RULES, clock, t, { extremesOnly: true })
      await compareTools(db, clock, t)
      expect({ side, differ: t.differ }).toEqual({ side, differ: [] })
      await db.close()
    }
  }, 300_000)

  it('every reader notices a bound 2 hours too tight', async () => {
    const rules = tally()
    const tools = tally()
    for (const m of MUTATION_CLOCKS) {
      for (const side of ['low', 'high'] as const) {
        // Fresh each time: the sentinels replace fixture rows.
        const db = await open()
        await seedSentinels(db, END + m * 60_000, side)
        const clock = clockAt(m)
        await compareRules(db, BOUNDED_RULES, clock, rules, { mutate: s => tighten(s, 26), extremesOnly: true, skipDiffered: true })
        await compareTools(db, clock, tools, { mutate: s => tighten(s, 26), skipDiffered: true })
        await db.close()
      }
    }
    const exempt = new Set(BOUNDED_RULES.filter(c => c.sql.includes('arg_max(m.')).map(c => c.ruleId))
    const missed = BOUNDED_RULES.map(c => c.ruleId).filter(id => !exempt.has(id) && !rules.differIds.has(id))
    expect(missed).toEqual([])
    expect([...exempt]).toEqual(['s.last-3d'])
    expect(TOOL_NAMES.filter(n => !tools.differIds.has(n))).toEqual([])
  }, 300_000)
})
