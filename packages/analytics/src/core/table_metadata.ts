/**
 * Sync/query metadata per warehouse table.
 *
 * Complements `TABLE_RETENTION` in `retention.ts` — that registry owns the
 * retention timestamp column and sweep policy; this one owns the *push/fetch*
 * watermark column and syncability flag.
 *
 * `timeColumn` — the monotonic column R2Pusher/R2Fetcher use to bound their
 * delta queries. Most tables use `ts`; `sleep_session` uses `ts_start`
 * (matches its `day(ts_start)` partition); `device_config` (SCD-2) uses
 * `valid_from`.
 *
 * `syncable` — `false` for pure-local tables (`sync_watermark`,
 * `tool_call_audit`). v0.2.0 consumers still pass explicit `tables` lists
 * to `pushAll`/fetcher; this flag exists so future callers can filter
 * without hard-coding.
 */

import type { AppSchema } from './app-schema'
import type { TableName } from './schemas'
import { HEALTH_TABLES } from '../packs/health/tables'
import { packTable } from './packs'
import { PLATFORM_TABLES } from './platform-tables'

export interface TableSyncMetadata {
  timeColumn: string
  syncable: boolean
}

/**
 * The pre-pack registry (≤ 0.52), for existing callers. The engine reads the
 * pack registry (`packTable`), which also knows tables registered later.
 */
export const TABLE_METADATA: Readonly<Record<TableName, TableSyncMetadata>> = Object.freeze(
  Object.fromEntries(
    Object.entries({ ...HEALTH_TABLES, ...PLATFORM_TABLES })
      .map(([name, t]) => [name, { timeColumn: t.timeColumn, syncable: t.syncable }]),
  ) as Record<TableName, TableSyncMetadata>,
)

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
