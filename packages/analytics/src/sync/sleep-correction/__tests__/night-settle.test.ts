/**
 * Per-night IANA offsets (the DST fix over v3.1's fixed offset) and the two
 * scalars the port adds: settle_min (R-C) and recovered_min.
 */
import type { ClassifiedRow, VitalSample } from '../classify'

import { describe, expect, it } from 'vitest'

import { nightOffsetHours, nightWindow } from '../night'
import { computeSettleMin, recoveredMinutes } from '../settle'

const at = (iso: string) => Date.parse(`${iso}Z`) / 1000
const DASH_RE = /-/g
const fmt = (e: number) => new Date(e * 1000).toISOString().slice(0, 19).replace('T', ' ').replace(DASH_RE, '.')

describe('nightOffsetHours', () => {
  it('is constant for a zone without DST', () => {
    expect(nightOffsetHours('2026-06-18', 'Asia/Kolkata')).toBe(5.5)
  })

  it('follows the fall-back change: the window starts 18:00 in whichever offset held then', () => {
    // US fall-back 2025-11-02 02:00. Night of Nov 2 starts Nov 1 18:00 PDT;
    // night of Nov 3 starts Nov 2 18:00 PST.
    expect(nightOffsetHours('2025-11-02', 'America/Los_Angeles')).toBe(-7)
    expect(nightOffsetHours('2025-11-03', 'America/Los_Angeles')).toBe(-8)
  })

  it('follows spring-forward too', () => {
    expect(nightOffsetHours('2026-03-08', 'America/Los_Angeles')).toBe(-8)
    expect(nightOffsetHours('2026-03-09', 'America/Los_Angeles')).toBe(-7)
  })

  it('puts the window at 18:00 local', () => {
    const w = nightWindow('2025-11-03', 'America/Los_Angeles')
    expect(w.windowStart).toBe(at('2025-11-03T02:00:00')) // Nov 2 18:00 PST
    expect(w.tzOffsetHours).toBe(-8)
  })

  it('refuses an unknown zone rather than defaulting to UTC', () => {
    expect(() => nightOffsetHours('2026-06-18', 'Mars/Olympus')).toThrow('unknown time zone')
  })
})

/** Primary firmware minutes from `from` for `minutes`. */
function night(from: string, minutes: number, source = 'firmware'): ClassifiedRow[] {
  const s = at(from)
  return Array.from({ length: minutes }, (_, i) => ({
    date: fmt(s + i * 60),
    quality: 2,
    start: fmt(s),
    unitLength: 1,
    source,
    confidence: 0.9,
    block_type: 'primary',
  }))
}

/** HR samples every 10 min from `from`, values in order. */
function hr(from: string, values: number[]): VitalSample[] {
  const s = at(from)
  return values.map((value, i) => ({ kind: 'hr', epoch: s + i * 600, value }))
}

describe('computeSettleMin', () => {
  const rows = night('2026-06-17T23:00:00', 420)

  it('counts minutes from bed to the first sustained low', () => {
    // night_min 60 ⇒ level 63. 23:20 is the first ≤ 63 and HR stays there.
    const v = hr('2026-06-17T23:00:00', [70, 66, 62, ...Array.from({ length: 30 }).fill(60) as number[]])
    expect(computeSettleMin(rows, v, 10)).toBe(20)
  })

  it('skips a low that does not hold for 15 minutes', () => {
    // 23:20 is low but 23:30 jumps; 23:40 onward holds ⇒ 40.
    const v = hr('2026-06-17T23:00:00', [70, 70, 60, 70, ...Array.from({ length: 30 }).fill(60) as number[]])
    expect(computeSettleMin(rows, v, 10)).toBe(40)
  })

  it('is null when HR never holds at the level', () => {
    const v = hr('2026-06-17T23:00:00', Array.from({ length: 40 }, (_, i) => (i % 2 ? 70 : 60)))
    expect(computeSettleMin(rows, v, 10)).toBeNull()
  })

  it('is null on the 30-min tier (R-C)', () => {
    const v = hr('2026-06-17T23:00:00', [70, 66, 62, ...Array.from({ length: 30 }).fill(60) as number[]])
    expect(computeSettleMin(rows, v, 30)).toBeNull()
  })

  it('is null with no primary block', () => {
    const secondary = rows.map(r => ({ ...r, block_type: 'secondary' }))
    expect(computeSettleMin(secondary, hr('2026-06-17T23:00:00', [60, 60, 60, 60]), 10)).toBeNull()
  })
})

describe('recoveredMinutes', () => {
  it('counts primary envelope/gap minutes only', () => {
    const rows = [
      ...night('2026-06-17T23:00:00', 10),
      ...night('2026-06-17T23:10:00', 5, 'envelope'),
      ...night('2026-06-17T23:15:00', 3, 'gap'),
      ...night('2026-06-18T07:00:00', 4, 'envelope').map(r => ({ ...r, block_type: 'secondary' })),
    ]
    expect(recoveredMinutes(rows)).toBe(8)
  })
})
