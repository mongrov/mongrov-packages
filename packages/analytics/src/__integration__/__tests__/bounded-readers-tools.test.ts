/*
 * The AI tools: the bounded form returns exactly what the view form returns,
 * text for text, at every clock and on the real `now()` — and a tool whose
 * bounded statement throws still answers, from the views
 * (mongrov-packages#44). Harness, fixture and method:
 * `setup/bounded-readers.ts`.
 */
import { describe, expect, it } from 'vitest'
import { CLOCK_MINUTES, clockAt, compareTools, open, tally, TOOL_NAMES } from '../setup/bounded-readers'

describe('bounded readers: AI tools (mongrov-packages#44)', () => {
  it('every switched tool: bounded == view, at every clock and zone', async () => {
    const db = await open()
    const t = tally()
    for (const m of CLOCK_MINUTES) await compareTools(db, clockAt(m), t)
    expect(t.differ).toEqual([])
    expect([...t.nonEmpty].sort()).toEqual(TOOL_NAMES)
    await db.close()
  }, 300_000)

  it('on the real now(), with the data shifted to it', async () => {
    const now = Math.floor(Date.now() / 60_000) * 60_000
    const db = await open({ origin: now - 33 * 86_400_000 - 13 * 60_000 })
    const t = tally()
    await compareTools(db, undefined, t)
    expect(t.differ).toEqual([])
    expect([...t.nonEmpty].sort()).toEqual(TOOL_NAMES)
    await db.close()
  }, 300_000)

  it('a tool whose bounded statement throws answers from the views, and says so', async () => {
    const db = await open()
    const t = tally()
    const failBounded = { n: 0, warned: [] as string[] }
    await compareTools(db, clockAt(CLOCK_MINUTES[1]!), t, { failBounded })
    expect(t.differ).toEqual([])
    expect(failBounded.n).toBeGreaterThan(0)
    expect([...new Set(failBounded.warned)].sort()).toEqual(TOOL_NAMES)
    await db.close()
  }, 300_000)
})
