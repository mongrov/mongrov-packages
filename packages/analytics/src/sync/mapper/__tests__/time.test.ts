/**
 * T-01 — Firmware timestamp + timezone module.
 *
 * Coverage matrix:
 *   1. Basic parse: `"YYYY.MM.DD HH:MM:SS"` round-trips to a UTC ISO instant.
 *   2. Parse rejects malformed shapes with a helpful message.
 *   3. `computeNightOf` — 6pm-6pm rule: 17:59 local -> yesterday; 18:00 -> today.
 *   4. `computeNightOf` — DST spring-forward (America/Los_Angeles, 2026-03-08 02:00
 *      does not exist). Reading at that instant still lands in the right night.
 *   5. `computeNightOf` — DST fall-back (America/Los_Angeles, 2026-11-01 01:30
 *      happens twice). Both instants share the same `night_of`.
 *   6. `computeNightOf` — midnight-crossing session: a reading at 23:30 and one
 *      at 03:30 the next day belong to the same night.
 */

import { describe, expect, it } from 'vitest'

import { computeNightOf, parseTimestamp } from '../time'

describe('parseTimestamp', () => {
  it('parses "YYYY.MM.DD HH:MM:SS" as UTC wall clock', () => {
    const d = parseTimestamp('2026.06.17 03:15:00')
    expect(d.toISOString()).toBe('2026-06-17T03:15:00.000Z')
  })

  it('tolerates single-digit month/day/hour parts (observed in ring firmware)', () => {
    const d = parseTimestamp('2026.6.7 3:5:9')
    expect(d.toISOString()).toBe('2026-06-07T03:05:09.000Z')
  })

  it('rejects malformed input with a message that names the offender', () => {
    expect(() => parseTimestamp('2026/06/17 03:15:00')).toThrow(
      /unrecognised firmware timestamp shape/,
    )
    expect(() => parseTimestamp('not a date')).toThrow(
      /unrecognised firmware timestamp shape/,
    )
  })
})

describe('computeNightOf — 6pm-6pm local rule', () => {
  it('17:59 local rolls into the previous day\'s night bucket', () => {
    // 2026-06-17 17:59 America/Los_Angeles = 2026-06-18 00:59 UTC.
    const local1759 = parseTimestamp('2026.06.18 00:59:00')
    const night = computeNightOf(local1759, 'America/Los_Angeles')
    // Night-of = 2026-06-16 midnight LA time = 2026-06-16 07:00 UTC (PDT: -07).
    expect(night.toISOString()).toBe('2026-06-16T07:00:00.000Z')
  })

  it('18:00 local starts a new night bucket', () => {
    // 2026-06-17 18:00 LA (PDT -07) = 2026-06-18 01:00 UTC.
    const local1800 = parseTimestamp('2026.06.18 01:00:00')
    const night = computeNightOf(local1800, 'America/Los_Angeles')
    // Night-of = 2026-06-17 midnight LA = 2026-06-17 07:00 UTC.
    expect(night.toISOString()).toBe('2026-06-17T07:00:00.000Z')
  })
})

describe('computeNightOf — DST transitions', () => {
  it('spring-forward: reading in the vanished 2am hour is bucketed to the same night', () => {
    // Los Angeles springs forward 2026-03-08 02:00 -> 03:00.
    // A reading right around that instant should still be bucketed to
    // night_of = 2026-03-07 (because 02:00 local is well before 18:00 the next
    // "morning").
    const evening = parseTimestamp('2026.03.08 05:00:00') // ~21:00 PST Mar 7
    const early = parseTimestamp('2026.03.08 10:30:00') // 02:30/03:30 PDT-ish Mar 8
    const nightA = computeNightOf(evening, 'America/Los_Angeles')
    const nightB = computeNightOf(early, 'America/Los_Angeles')
    expect(nightA.toISOString()).toBe(nightB.toISOString())
  })

  it('fall-back: both occurrences of the doubled 1am share the same night', () => {
    // Los Angeles falls back 2026-11-01 02:00 -> 01:00.
    // 01:30 local happens twice: first at 08:30 UTC (PDT still), then at 09:30
    // UTC (PST). Both should land in night_of = 2026-10-31.
    const firstOccurrence = parseTimestamp('2026.11.01 08:30:00')
    const secondOccurrence = parseTimestamp('2026.11.01 09:30:00')
    const nightA = computeNightOf(firstOccurrence, 'America/Los_Angeles')
    const nightB = computeNightOf(secondOccurrence, 'America/Los_Angeles')
    expect(nightA.toISOString()).toBe(nightB.toISOString())
    // And the night is 2026-10-31 midnight LA (PDT -07) = 2026-10-31 07:00 UTC.
    expect(nightA.toISOString()).toBe('2026-10-31T07:00:00.000Z')
  })
})

describe('computeNightOf — midnight-crossing session', () => {
  it('groups pre-midnight and post-midnight reads into one night', () => {
    // 23:30 LA on 2026-06-17 = 2026-06-18 06:30 UTC.
    // 03:30 LA on 2026-06-18 = 2026-06-18 10:30 UTC.
    // Both live inside [2026-06-17 18:00, 2026-06-18 18:00) local, so both
    // must resolve to night_of = 2026-06-17.
    const before = parseTimestamp('2026.06.18 06:30:00')
    const after = parseTimestamp('2026.06.18 10:30:00')
    const nightA = computeNightOf(before, 'America/Los_Angeles')
    const nightB = computeNightOf(after, 'America/Los_Angeles')
    expect(nightA.toISOString()).toBe(nightB.toISOString())
    expect(nightA.toISOString()).toBe('2026-06-17T07:00:00.000Z')
  })
})

describe('computeNightOf — input validation', () => {
  it('rejects a non-Date ts', () => {
    // @ts-expect-error deliberately wrong shape
    expect(() => computeNightOf('nope', 'UTC')).toThrow(TypeError)
  })

  it('rejects an empty tz', () => {
    expect(() => computeNightOf(new Date(), '')).toThrow(TypeError)
  })
})
