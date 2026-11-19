import type { FlushResult } from './types'

/**
 * Fold a post-flush job's flush results into a batch's per-table results.
 *
 * The batch may have flushed a job's output tables once already (empty: the
 * derived rows did not exist yet), so the job's result is merged into that
 * entry rather than appended — one entry per table, as callers that key by
 * table (`Object.fromEntries`) expect. Counts add; a failure on either side
 * makes the table failed, keeping the first error.
 */
export function mergeFlushResults(results: readonly FlushResult[], derived: readonly FlushResult[]): FlushResult[] {
  const out = [...results]
  for (const d of derived) {
    const i = out.findIndex(r => r.table === d.table)
    if (i === -1) {
      out.push(d)
      continue
    }
    const r = out[i]
    const inserted = (r.rowsInserted ?? 0) + (d.rowsInserted ?? 0)
    const rejected = (r.rowsRejected ?? 0) + (d.rowsRejected ?? 0)
    out[i] = {
      ...r,
      ...d,
      table: r.table,
      rowsFlushed: r.rowsFlushed + d.rowsFlushed,
      ...(r.rowsInserted != null || d.rowsInserted != null ? { rowsInserted: inserted } : {}),
      ...(r.rowsRejected != null || d.rowsRejected != null ? { rowsRejected: rejected } : {}),
      ok: r.ok && d.ok,
      ...(r.error ?? d.error ? { error: r.error ?? d.error } : {}),
    }
  }
  return out
}
