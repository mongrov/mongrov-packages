/**
 * Rows dropped at ingest (spec §13 S10, T-60): what a table's validator
 * rejects is counted, by table and reason, and reported once per flush.
 *
 * Validation itself is the pack's: a table declares `validate`, and
 * `validateRows` applies it. A table without one passes through untouched.
 */

import { packTable } from '../core/packs'

/** One line per flush: the rows dropped (and readings nulled) since the last. */
export const DROPPED_ROWS_EVENT = 'sync.flush.dropped'

export interface DropReport<R extends string = string> {
  /** Rows that survived, in their original order. */
  kept: Record<string, unknown>[]
  /** How many rows were dropped. */
  dropped: number
  /** `dropped`, split by reason. Only reasons that occurred are present. */
  reasons: Partial<Record<R, number>>
  /**
   * How many rows were kept with a value set to NULL rather than dropped
   * (a validator's choice for a row that still carries other values).
   */
  nulled: number
  /** One example, naming the offending value — for the log line. */
  sample?: string
}

/** Apply a table's declared validator; tables without one pass through. */
export function validateRows(table: string, rows: readonly Record<string, unknown>[]): DropReport {
  const validate = packTable(table)?.validate
  return validate ? validate(rows) : { kept: [...rows], dropped: 0, reasons: {}, nulled: 0 }
}

/** What one flush reports on `DROPPED_ROWS_EVENT`. */
export interface DropSummary {
  /** Dropped rows by table, then reason. */
  dropped: Record<string, Partial<Record<string, number>>>
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
      for (const [reason, n] of Object.entries(report.reasons) as Array<[string, number]>)
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
