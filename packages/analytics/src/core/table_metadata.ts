/**
 * Sync/query metadata per warehouse table, read from the table's pack
 * declaration (`PackTable`) or the app's `appSchema`.
 *
 * Complements `PackTable.retention` (the retention timestamp column and
 * sweep policy, applied in `retention.ts`); this one owns the *push/fetch*
 * watermark column and syncability flag.
 *
 * `timeColumn` — the monotonic column R2Pusher/R2Fetcher use to bound their
 * delta queries. Most tables use `ts`; a session table may use its start
 * column (matching a `day(<start>)` partition); an SCD-2 table its
 * `valid_from`.
 *
 * `syncable` — `false` for pure-local tables (`sync_watermark`,
 * `tool_call_audit`). Callers still pass explicit `tables` lists to
 * `pushAll` / the fetcher; this flag lets them filter without hard-coding.
 */

import type { AppSchema } from './app-schema'
import { packTable } from './packs'

export interface TableSyncMetadata {
  timeColumn: string
  syncable: boolean
}

function metadataFor(table: string, appSchema?: AppSchema): TableSyncMetadata | undefined {
  return packTable(table) ?? appSchema?.tables[table]
}

/**
 * Resolve the sync watermark column for a table — a pack table, or one the
 * app declared in `appSchema`.
 *
 * Falls back to `'ts'` for unknown table names so downstream callers stay
 * compatible if the schema catalog and this registry drift.
 */
export function timeColumnFor(table: string, appSchema?: AppSchema): string {
  return metadataFor(table, appSchema)?.timeColumn ?? 'ts'
}

/**
 * Whether a table participates in R2 push/fetch. `false` for warehouse-local
 * tables that carry no cross-device state (`sync_watermark`,
 * `tool_call_audit`).
 */
export function isSyncable(table: string, appSchema?: AppSchema): boolean {
  return metadataFor(table, appSchema)?.syncable ?? false
}
