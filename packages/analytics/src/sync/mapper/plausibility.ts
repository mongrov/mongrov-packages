/**
 * Drop rows that are not readings at all; store every reading, however odd
 * (sprint6 spec §13 amendment 2026-11-12, S10 "flag, don't delete").
 *
 * History. A real ring sent a filler temperature sample: `65378 * 0.1 =
 * 6537.8 °C`, which `temp_c DECIMAL(4,1)` cannot hold. The cast failed, the
 * whole 662-row batch was rejected, and temperature never reached the
 * warehouse at all (zivaone_app#225). From then until T-60 this guard also
 * dropped every value outside the §13b clamps. That contradicted "excluded
 * readings are flagged, never deleted": a dropped row cannot be gated back on
 * with `rangeFilter: false`, replayed, or explained to a user who asks where
 * a reading went. Now an out-of-range value is STORED, and `v_*_q.plausible`
 * flags it at read time exactly as before; `_clean` skips it while
 * `rangeFilter` is on.
 *
 * Only malformed rows are dropped, each counted by reason (`DropReason`):
 *
 *   - `bad_timestamp`: no timestamp, or one that does not parse.
 *   - `future`: dated beyond now + `MAX_CLOCK_AHEAD_DAYS`. The same 0xFF
 *     padding decodes to dates like `2034.01.30`, which `parseTimestamp`
 *     accepts: the SHAPE is valid, only the date is absurd. The bound is
 *     generous on purpose. A ring whose clock runs weeks ahead is ordinary,
 *     and its readings are real.
 *   - `before_epoch`: dated before `EARLIEST_PLAUSIBLE_ISO` (a reset clock
 *     reads 1970).
 *   - `undecodable`: a value that is not a finite number, or one the column
 *     cannot store (`STORABLE_ABS`), so it would fail the flush cast (#225).
 *   - `no_value`: the firmware's "no value" sentinel (`NO_VALUE`) or NULL, on
 *     a table whose row carries nothing else. On `hrv` (`NULL_NOT_DROP`) the
 *     reading is set to NULL and the row kept instead, so its stress survives.
 */

import type { PLAUSIBLE_RANGES } from '../../core/reading-quality'

/** Metric column per table, for the tables that carry a single reading value. */
const VALUE_COLUMN: Record<string, keyof typeof PLAUSIBLE_RANGES> = {
  temperature: 'temp_c',
  spo2: 'spo2',
  heart_rate: 'bpm',
  hrv: 'hrv_ms',
}

/**
 * Tables whose row carries more than the one guarded reading, so a reading
 * that is not one is nulled and the row kept rather than dropped.
 *
 * An `hrv` row also carries `stress` (and the collected-only BP fields), and
 * plausibility is per vital, not per row (sprint6 spec §13b): the canonical
 * fixture `techspec/.specifica/fixtures/firmware-dirty-readings.json` says
 * "10:00 HRV 0 is below the 5 ms clamp; its stress 35 stays clean". Only a
 * malformed TIMESTAMP drops an `hrv` row: then none of its readings can be
 * placed.
 */
const NULL_NOT_DROP = new Set(['hrv'])

/**
 * The firmware's "no value" sentinel: a 0 is the ring saying it has no
 * reading, not a reading of 0 (packages#82, spec §13 S10 "HRV 0 stays NULL").
 * Stored, it would be counted as a reading by every query on the raw view.
 */
const NO_VALUE = 0

/**
 * The largest magnitude a column can store, where it is narrower than the
 * INTEGER default. A value beyond it fails the flush's cast and, before #226,
 * took the whole batch with it: it is not a reading that can be flagged.
 */
const STORABLE_ABS: Partial<Record<keyof typeof PLAUSIBLE_RANGES, number>> = {
  temp_c: 999.9, // DECIMAL(4,1)
}
const INTEGER_ABS = 2_147_483_647
/**
 * How far ahead of now a reading may be dated and still be believed. A ring
 * clock running weeks fast is a real, observed condition; eight years is not.
 */
export const MAX_CLOCK_AHEAD_DAYS = 30

/** Nothing from this ring predates the product. */
export const EARLIEST_PLAUSIBLE_ISO = '2020-01-01T00:00:00.000Z'

/**
 * The log event the app's live BLE path (zivaone_app `sensor-adapter.ts`)
 * reports its own drops on. The package no longer logs on it: drops are
 * reported once per flush on `DROPPED_ROWS_EVENT`.
 *
 * @deprecated kept so existing imports keep compiling.
 */
export const IMPLAUSIBLE_ROWS_EVENT = 'sensor-adapter.rows.implausible'

/** One line per flush: the rows dropped (and readings nulled) since the last. */
export const DROPPED_ROWS_EVENT = 'sync.flush.dropped'

/** Why a row was dropped at ingest. See the module comment. */
export type DropReason = 'bad_timestamp' | 'future' | 'before_epoch' | 'undecodable' | 'no_value'

export interface DropReport {
  /** Rows that survived, in their original order. */
  kept: Record<string, unknown>[]
  /** How many rows were dropped. */
  dropped: number
  /** `dropped`, split by reason. Only reasons that occurred are present. */
  reasons: Partial<Record<DropReason, number>>
  /**
   * How many rows were kept with their reading set to NULL — `hrv` only (see
   * `NULL_NOT_DROP`). Always present, 0 for every other table.
   */
  nulled: number
  /** One example, naming the offending value — for the log line. */
  sample?: string
}

function timestampOf(row: Record<string, unknown>): number | undefined {
  const ts = row.ts
  if (ts instanceof Date)
    return Number.isNaN(ts.getTime()) ? undefined : ts.getTime()
  if (typeof ts === 'string' || typeof ts === 'number') {
    const parsed = new Date(ts).getTime()
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

/**
 * Split mapped rows into the ones to store and a count, by reason, of the
 * malformed rest. Out-of-range values are kept: `v_*_q.plausible` flags them.
 *
 * Unknown tables pass through untouched: this guards reading tables, and a
 * table with no declared reading column is not one of them.
 */
export function dropMalformedRows(
  table: string,
  rows: readonly Record<string, unknown>[],
  now: Date = new Date(),
): DropReport {
  const column = VALUE_COLUMN[table]
  if (!column)
    return { kept: [...rows], dropped: 0, reasons: {}, nulled: 0 }
  const nullInstead = NULL_NOT_DROP.has(table)
  const storable = STORABLE_ABS[column] ?? INTEGER_ABS

  const floor = new Date(EARLIEST_PLAUSIBLE_ISO).getTime()
  const ceiling = now.getTime() + MAX_CLOCK_AHEAD_DAYS * 86_400_000

  const kept: Record<string, unknown>[] = []
  const reasons: Partial<Record<DropReason, number>> = {}
  let dropped = 0
  let nulled = 0
  let sample: string | undefined

  for (const row of rows) {
    const ts = timestampOf(row)
    let reason: DropReason | undefined
    let why = ''
    if (ts === undefined) {
      reason = 'bad_timestamp'
      why = `ts=${String(row.ts)} is not a date`
    }
    else if (ts > ceiling) {
      reason = 'future'
      why = `ts=${new Date(ts).toISOString()} is more than ${MAX_CLOCK_AHEAD_DAYS} days ahead`
    }
    else if (ts < floor) {
      reason = 'before_epoch'
      why = `ts=${new Date(ts).toISOString()} is before ${EARLIEST_PLAUSIBLE_ISO}`
    }
    else {
      const raw = row[column]
      const value = raw == null ? Number.NaN : Number(raw)
      if (raw == null || value === NO_VALUE) {
        reason = 'no_value'
        why = `${column}=${String(raw)} is the no-value sentinel`
      }
      else if (!Number.isFinite(value) || Math.abs(value) > storable) {
        reason = 'undecodable'
        why = `${column}=${String(raw)} cannot be stored`
      }
      if (reason !== undefined && nullInstead) {
        // A NULL reading is already "no reading": keep it, uncounted.
        if (raw == null) {
          kept.push(row)
          continue
        }
        kept.push({ ...row, [column]: null })
        nulled += 1
        sample ??= `${why}, set to NULL`
        continue
      }
    }

    if (reason === undefined) {
      kept.push(row)
      continue
    }
    dropped += 1
    reasons[reason] = (reasons[reason] ?? 0) + 1
    sample ??= why
  }

  return { kept, dropped, reasons, nulled, ...(sample === undefined ? {} : { sample }) }
}

/**
 * The pre-T-60 name. It dropped out-of-range values too; it is now the same
 * function as `dropMalformedRows`, which stores them.
 *
 * @deprecated use `dropMalformedRows`.
 */
export const dropImplausibleRows = dropMalformedRows

/** What one flush reports on `DROPPED_ROWS_EVENT`. */
export interface DropSummary {
  /** Dropped rows by table, then reason. */
  dropped: Record<string, Partial<Record<DropReason, number>>>
  /** Readings set to NULL (row kept), by table. */
  nulled: Record<string, number>
  /** Total dropped rows across tables. */
  total: number
  /** One example per table. */
  samples: Record<string, string>
}

/**
 * Drop counts accumulated between flushes, so the sync log carries one line
 * per flush rather than one per pushed chunk.
 */
export class DropTally {
  #summary: DropSummary = emptySummary()

  add(table: string, report: DropReport): void {
    if (report.dropped === 0 && report.nulled === 0)
      return
    const s = this.#summary
    if (report.dropped > 0) {
      const byReason = (s.dropped[table] ??= {})
      for (const [reason, n] of Object.entries(report.reasons) as Array<[DropReason, number]>)
        byReason[reason] = (byReason[reason] ?? 0) + n
      s.total += report.dropped
    }
    if (report.nulled > 0)
      s.nulled[table] = (s.nulled[table] ?? 0) + report.nulled
    if (report.sample !== undefined)
      s.samples[table] ??= report.sample
  }

  /** The counts since the last drain, and reset; undefined when nothing happened. */
  drain(): DropSummary | undefined {
    const s = this.#summary
    if (s.total === 0 && Object.keys(s.nulled).length === 0)
      return undefined
    this.#summary = emptySummary()
    return s
  }
}

function emptySummary(): DropSummary {
  return { dropped: {}, nulled: {}, total: 0, samples: {} }
}
