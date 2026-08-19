/**
 * The chart rules that are easy to get wrong, tested where they are cheap.
 *
 * Every case here corresponds to a screen defect: a short day, a bridged gap,
 * or amber on a calm day.
 */

import { describe, expect, it } from 'vitest'

import { mapMarks, slotLabel } from '../map/marks'

const zoneFor = (v: number) => (v >= 95 ? 'typical' : v >= 90 ? 'slightly-low' : 'low')
const base = { slotCount: 48, minutesPerSlot: 30, zoneFor, exceptionBelow: 90 }

describe('the grid is dense even though the query is sparse', () => {
  it('always returns cadence.slotCount marks', () => {
    // Two rows in, 48 marks out. A screen iterating marks draws the day, so a
    // sparse array silently shortens it.
    const marks = mapMarks([{ slot_index: 0, value_avg: 97, context: 'asleep' }], base)
    expect(marks).toHaveLength(48)
  })

  it('fills unreported slots as gaps rather than omitting them', () => {
    const marks = mapMarks([{ slot_index: 5, value_avg: 96, context: 'awake' }], base)
    expect(marks[6].value).toBeNull()
    expect(marks[6].zone).toBe('gap')
    // The slot exists, so the screen can render the gap instead of bridging.
    expect(marks[6].slot).toBe(6)
  })

  it('keeps slots in order regardless of row order', () => {
    const marks = mapMarks([
      { slot_index: 9, value_avg: 96, context: 'awake' },
      { slot_index: 2, value_avg: 95, context: 'asleep' },
    ], base)
    expect(marks.map(m => m.slot)).toEqual([...marks.map(m => m.slot)].sort((a, b) => a - b))
    expect(marks[2].value).toBe(95)
    expect(marks[9].value).toBe(96)
  })

  it('drops out-of-range slots rather than letting them vanish silently', () => {
    const marks = mapMarks([
      { slot_index: 99, value_avg: 90, context: 'awake' },
      { slot_index: -1, value_avg: 90, context: 'awake' },
    ], base)
    expect(marks).toHaveLength(48)
    expect(marks.every(m => m.value === null)).toBe(true)
  })
})

describe('tone follows the exception, not the value', () => {
  it('leaves a low-but-not-crossing reading calm', () => {
    // 92 is `slightly-low` but above the user's 90 level. Information, not a
    // warning — this is what keeps a Normal day free of amber.
    const marks = mapMarks([{ slot_index: 0, value_avg: 92, context: 'awake' }], base)
    expect(marks[0].zone).toBe('slightly-low')
    expect(marks[0].isException).toBe(false)
    expect(marks[0].tone).toBe('good')
  })

  it('goes hot only on a crossing', () => {
    const marks = mapMarks([{ slot_index: 0, value_avg: 88, context: 'awake' }], base)
    expect(marks[0].isException).toBe(true)
    expect(marks[0].tone).toBe('attention')
  })

  it('never marks a gap as an exception', () => {
    const marks = mapMarks([], base)
    expect(marks.every(m => !m.isException)).toBe(true)
    expect(marks.every(m => m.tone === 'neutral')).toBe(true)
  })

  it('supports a high-side vital too', () => {
    // Temperature and HR cross upward; the same mapper must serve both.
    const marks = mapMarks(
      [{ slot_index: 0, value_avg: 38.4, context: 'awake' }],
      { ...base, exceptionBelow: undefined, exceptionAbove: 37.5, zoneFor: () => 'warm' },
    )
    expect(marks[0].isException).toBe(true)
  })
})

describe('slot labels are display-ready', () => {
  it('formats midnight and noon correctly', () => {
    expect(slotLabel(0, 30)).toBe('12:00 AM')
    expect(slotLabel(24, 30)).toBe('12:00 PM')
  })

  it('handles half-hour slots and a finer cadence', () => {
    expect(slotLabel(9, 30)).toBe('4:30 AM')
    // 10-minute cadence (Heart Rate) — slot count comes from cadence, so the
    // mapper must not assume 30.
    expect(slotLabel(9, 10)).toBe('1:30 AM')
  })
})
