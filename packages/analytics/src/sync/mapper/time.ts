/**
 * Firmware timestamp + timezone utilities (T-01).
 *
 * Firmware exports ring readings in a `"YYYY.MM.DD HH:MM:SS"` string, wall-clock
 * UTC. The mapper needs two operations:
 *
 *   1. `parseTimestamp(fwStr)` — turn the firmware string into an ISO instant.
 *   2. `computeNightOf(ts, tz)` — assign a reading to a sleep-night bucket via
 *      the 6pm-6pm local rule (readings between 18:00 local of day D and 18:00
 *      local of D+1 belong to `night_of = D`).
 *
 * The `night_of` computation must be timezone-aware because the rule is defined
 * in the user's IANA timezone (`ctx.userTimezone`), and DST transitions can
 * shift the wall-clock boundary. We defer to `date-fns-tz` for the IANA math.
 *
 * See `.specifica/features/analytics-sync/spec.md` §Firmware mapper for the
 * timestamp contract and `design.md` §sync/mapper/firmware.ts for the module
 * shape.
 */

import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'

/**
 * Match `"YYYY.MM.DD HH:MM:SS"` exactly. Firmware writes UTC into this shape.
 *
 * We accept a single-digit month/day/hour/minute/second tolerantly because the
 * ring firmware has been observed to omit leading zeros on some fields.
 */
const FIRMWARE_TIMESTAMP_RE
  = /^(\d{4})\.(\d{1,2})\.(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/

/**
 * Parse a firmware timestamp string into a `Date` (ISO instant, UTC).
 *
 * Contract: input is UTC wall-clock (`"2026.06.17 03:15:00"` = 03:15 UTC).
 *
 * @throws {Error} if the string does not match `"YYYY.MM.DD HH:MM:SS"`.
 */
export function parseTimestamp(fwStr: string): Date {
  if (typeof fwStr !== 'string') {
    throw new TypeError(
      `parseTimestamp: expected string, got ${typeof fwStr}`,
    )
  }
  const match = fwStr.match(FIRMWARE_TIMESTAMP_RE)
  if (!match) {
    throw new Error(
      `parseTimestamp: unrecognised firmware timestamp shape: ${JSON.stringify(fwStr)}`,
    )
  }
  const [, y, m, d, hh, mm, ss] = match
  const iso = `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:${pad(ss)}.000Z`
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `parseTimestamp: produced an invalid Date from ${JSON.stringify(fwStr)}`,
    )
  }
  return parsed
}

/**
 * Assign an instant to a sleep-night bucket in the user's timezone.
 *
 * Rule (spec.md §Firmware mapper):
 *   Readings whose local (in `tz`) wall-clock is in the interval
 *     `[D 18:00, D+1 18:00)`
 *   are attributed to `night_of = D`.
 *
 * Returned as a UTC `Date` at midnight of `D` in the user's timezone. This
 * matches the `DATE` column shape in `sleep_session.night_of` and lets
 * `date_trunc`/`GROUP BY` queries stay timezone-honest.
 *
 * DST handling:
 *   - Spring-forward gap (02:00 becomes 03:00): a reading in the vanished hour
 *     is treated as the following instant by `date-fns-tz`, so the boundary is
 *     preserved.
 *   - Fall-back double hour (01:00 occurs twice): both occurrences share the
 *     same local wall-clock and therefore the same `night_of`. This is the
 *     desired behavior — the user experiences one continuous night.
 */
export function computeNightOf(ts: Date, tz: string): Date {
  if (!(ts instanceof Date) || Number.isNaN(ts.getTime())) {
    throw new TypeError('computeNightOf: ts must be a valid Date')
  }
  if (typeof tz !== 'string' || tz.length === 0) {
    throw new TypeError('computeNightOf: tz must be a non-empty IANA string')
  }
  // `formatInTimeZone` is unambiguous: it renders `ts` as wall-clock in `tz`
  // regardless of the JS runtime's local zone. `toZonedTime` semantics changed
  // in v3 (returns a Date whose *local* methods reflect zoned time), so we
  // avoid it here in favour of pure string extraction.
  const localDate = formatInTimeZone(ts, tz, 'yyyy-MM-dd') // e.g. '2026-06-17'
  const localHour = Number(formatInTimeZone(ts, tz, 'HH')) // 0..23
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number]

  // If before 18:00 local, roll back one day. Use UTC arithmetic so we get
  // safe rollover across month/year boundaries without accidentally consulting
  // the runtime's local timezone.
  let nightY = y
  let nightM = m
  let nightD = d
  if (localHour < 18) {
    const rolled = new Date(Date.UTC(y, m - 1, d - 1))
    nightY = rolled.getUTCFullYear()
    nightM = rolled.getUTCMonth() + 1
    nightD = rolled.getUTCDate()
  }

  // Build the local-midnight ISO string for the night's day, then convert to
  // the equivalent UTC instant via `fromZonedTime`.
  const isoLocalMidnight = `${nightY.toString().padStart(4, '0')}-${nightM
    .toString()
    .padStart(2, '0')}-${nightD.toString().padStart(2, '0')}T00:00:00.000`

  return fromZonedTime(isoLocalMidnight, tz)
}

function pad(n: string): string {
  return n.length === 1 ? `0${n}` : n
}
