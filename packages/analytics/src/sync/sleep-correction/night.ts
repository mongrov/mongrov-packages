/**
 * Per-night offsets from the user's IANA zone (principle 24).
 *
 * v3.1 passed one fixed device offset (`getTzOffsetHours()`) for every night,
 * so on the nights either side of a DST change the 18:00→18:00 window sat an
 * hour off. The port asks the zone what offset is in force at the START of
 * each night's window — 18:00 local on the previous day — and hands that to
 * the v3.1 arithmetic unchanged.
 *
 * Offsets are read for INSTANTS via `formatInTimeZone(…, 'xxx')`. Not
 * date-fns-tz's `getTimezoneOffset(zone, date)`: that reads the Date's fields
 * as a wall-clock time in the zone, so `2026-03-08T02:00Z` (Mar 7 18:00 PST)
 * comes back as −7 — 02:00 is the spring-forward wall time. Measured; the
 * spring-forward test pins it.
 */

import { formatInTimeZone } from 'date-fns-tz'

import { computeNightEpochs } from './classify'

const OFFSET_RE = /^([+-])(\d{2}):(\d{2})$/

/** UTC offset (ms) in force at the instant `epochMs` in `timeZone`. */
export function offsetAtInstantMs(timeZone: string, epochMs: number): number {
  let text: string
  try {
    text = formatInTimeZone(new Date(epochMs), timeZone, 'xxx')
  }
  catch {
    throw new Error(`sleep-correction: unknown time zone ${JSON.stringify(timeZone)}`)
  }
  const m = OFFSET_RE.exec(text)
  if (!m)
    throw new Error(`sleep-correction: unreadable offset ${JSON.stringify(text)} for ${timeZone}`)
  const ms = (Number(m[2]) * 60 + Number(m[3])) * 60_000
  return m[1] === '-' ? -ms : ms
}

/** UTC offset (hours) in force at 18:00 local on the day before `nightIso`. */
export function nightOffsetHours(nightIso: string, timeZone: string): number {
  const [y, m, d] = nightIso.split('-').map(Number)
  // Local 18:00 as if it were UTC; one correction by the offset near that
  // instant lands on the true local 18:00, and the offset there is the answer.
  const wall = Date.UTC(y, m - 1, d - 1, 18)
  const guess = offsetAtInstantMs(timeZone, wall)
  return offsetAtInstantMs(timeZone, wall - guess) / 3_600_000
}

/** The night's epoch window plus the offset it was computed with. */
export function nightWindow(
  nightIso: string,
  timeZone: string,
): { windowStart: number, windowEnd: number, tzOffsetHours: number } {
  const tzOffsetHours = nightOffsetHours(nightIso, timeZone)
  return { ...computeNightEpochs(nightIso, tzOffsetHours), tzOffsetHours }
}
