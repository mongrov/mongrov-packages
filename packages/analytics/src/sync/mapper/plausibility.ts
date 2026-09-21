/**
 * Drop readings the device could not have taken (zivaone_app#225).
 *
 * A real ring sent a filler temperature sample: `65378 * 0.1 = 6537.8 °C`,
 * which `temp_c DECIMAL(4,1)` cannot hold. The cast failed, the whole 662-row
 * batch was rejected, and temperature never reached the warehouse at all —
 * the screens honestly reported "Never measured" while the ring streamed
 * hundreds of readings a day.
 *
 * The flusher no longer lets one such row cost a whole table (#226), but
 * quarantining a row there is a last resort: the loss is already counted and
 * the value is already gone. Filler belongs at the boundary where its shape
 * is still recognisable, before anything downstream treats it as a reading.
 *
 * Two families are dropped, both seen in the same firmware pages:
 *
 *   - Values outside the metric's plausible range. `PLAUSIBLE_RANGES` is the
 *     same bound the clean views apply, so this stores nothing a quality view
 *     would have hidden anyway.
 *   - Timestamps outside a sane window. The same 0xFF-padded pages decode to
 *     dates like `2034.01.30`, which `parseTimestamp` accepts: the SHAPE is
 *     valid, only the date is absurd.
 *
 * The future bound is deliberately generous. A ring whose clock runs ahead is
 * ordinary — readings dated a couple of weeks out are real and are kept,
 * because "this week" and "this month" run to their end and a reading dropped
 * here would be missing from a window that legitimately covers it. Only a
 * date no clock drift explains is filler.
 */

import { PLAUSIBLE_RANGES } from '../../core/reading-quality'

/** Metric column per table, for the tables that carry a single reading value. */
const VALUE_COLUMN: Record<string, keyof typeof PLAUSIBLE_RANGES> = {
  temperature: 'temp_c',
  spo2: 'spo2',
  heart_rate: 'bpm',
  hrv: 'hrv_ms',
}

/**
 * How far ahead of now a reading may be dated and still be believed. A ring
 * clock running weeks fast is a real, observed condition; eight years is not.
 */
export const MAX_CLOCK_AHEAD_DAYS = 30

/** Nothing from this ring predates the product. */
export const EARLIEST_PLAUSIBLE_ISO = '2020-01-01T00:00:00.000Z'

export interface DropReport {
  /** Rows that survived, in their original order. */
  kept: Record<string, unknown>[]
  /** How many rows were dropped. */
  dropped: number
  /** One example, naming the offending value — for the log line. */
  sample?: string
}

function timestampOf(row: Record<string, unknown>): number | undefined {
  const ts = row.ts
  if (ts instanceof Date)
    return ts.getTime()
  if (typeof ts === 'string' || typeof ts === 'number') {
    const parsed = new Date(ts).getTime()
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

/**
 * Split mapped rows into the believable ones and a count of the rest.
 *
 * Unknown tables pass through untouched: this guards reading tables, and a
 * table with no declared range is not one of them.
 */
export function dropImplausibleRows(
  table: string,
  rows: readonly Record<string, unknown>[],
  now: Date = new Date(),
): DropReport {
  const column = VALUE_COLUMN[table]
  if (!column)
    return { kept: [...rows], dropped: 0 }

  const [min, max] = PLAUSIBLE_RANGES[column]
  const floor = new Date(EARLIEST_PLAUSIBLE_ISO).getTime()
  const ceiling = now.getTime() + MAX_CLOCK_AHEAD_DAYS * 86_400_000

  const kept: Record<string, unknown>[] = []
  let dropped = 0
  let sample: string | undefined

  for (const row of rows) {
    const value = Number(row[column])
    const ts = timestampOf(row)
    let reason: string | undefined

    if (!Number.isFinite(value) || value < min || value > max)
      reason = `${column}=${row[column]} outside [${min}, ${max}]`
    else if (ts === undefined)
      reason = `ts=${String(row.ts)} is not a date`
    else if (ts < floor || ts > ceiling)
      reason = `ts=${new Date(ts).toISOString()} outside the believable window`

    if (reason === undefined) {
      kept.push(row)
      continue
    }
    dropped += 1
    sample ??= reason
  }

  return { kept, dropped, ...(sample === undefined ? {} : { sample }) }
}
