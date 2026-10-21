/*
 * Rule shapes the catalogs do not all cover — consecutive (absolute, range,
 * resting), day cadence (absolute, resting baseline_offset), per_session,
 * phase_band (defaults + asleep, stored rails + resting), baseline percent and
 * stddev with contexts, minDays, `last`, `count`: the bounded form returns
 * exactly what the view form returns, at every clock (mongrov-packages#44).
 * Harness, fixture and method: `setup/bounded-readers.ts`.
 */
import { describe, expect, it } from 'vitest'
import { BOUNDED_SYNTHETIC, CLOCK_MINUTES, clockAt, compareRules, COMPILED, open, tally } from '../setup/bounded-readers'

describe('bounded readers: synthetic rule shapes (mongrov-packages#44)', () => {
  it('every synthetic shape: bounded == view, at every clock', async () => {
    const db = await open()
    const t = tally()
    for (const m of CLOCK_MINUTES) await compareRules(db, BOUNDED_SYNTHETIC, clockAt(m), t)
    expect(t.differ).toEqual([])
    expect(BOUNDED_SYNTHETIC.map(c => c.ruleId).filter(id => !t.nonEmpty.has(id))).toEqual([])
    // per_session reads sleep sessions, which have no quality macro.
    expect(COMPILED.find(c => c.ruleId === 's.per-session')!.boundedSql).toBeUndefined()
    await db.close()
  }, 300_000)
})
