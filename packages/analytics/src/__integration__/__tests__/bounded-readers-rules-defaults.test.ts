/*
 * Every default rule, all four brand catalogs: the bounded form returns
 * exactly what the view form returns, at every clock (mongrov-packages#44).
 * Harness, fixture and method: `setup/bounded-readers.ts`.
 */
import { describe, expect, it } from 'vitest'
import { BOUNDED_DEFAULTS, CLOCK_MINUTES, clockAt, compareRules, COMPILED, DEFAULT_RULES, open, tally } from '../setup/bounded-readers'

describe('bounded readers: default rules (mongrov-packages#44)', () => {
  it('every default rule on a vital: bounded == view, at every clock', async () => {
    const db = await open()
    const t = tally()
    for (const m of CLOCK_MINUTES) await compareRules(db, BOUNDED_DEFAULTS, clockAt(m), t)
    expect(t.differ).toEqual([])
    // Non-vacuity: every bounded rule produced rows somewhere.
    expect(BOUNDED_DEFAULTS.map(c => c.ruleId).filter(id => !t.nonEmpty.has(id))).toEqual([])
    await db.close()
  }, 300_000)

  it('every catalog rule on a vital has a bounded form; the others do not', () => {
    const ids = new Set(DEFAULT_RULES.map(r => r.id))
    const defaults = COMPILED.filter(c => ids.has(c.ruleId))
    for (const c of defaults) {
      const vital = /FROM v_(?:heart_rate|hrv|spo2|temperature)_clean m/.test(c.sql)
      expect({ id: c.ruleId, bounded: c.boundedSql !== undefined }).toEqual({ id: c.ruleId, bounded: vital })
    }
    expect(BOUNDED_DEFAULTS.length).toBeGreaterThanOrEqual(10)
  })
})
