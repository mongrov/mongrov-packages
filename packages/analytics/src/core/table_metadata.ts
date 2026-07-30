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

import type { TableName } from './schemas'

export interface TableSyncMetadata {
  timeColumn: string
  syncable: boolean
}

export const TABLE_METADATA: Readonly<Record<TableName, TableSyncMetadata>> = Object.freeze({
  hrv: { timeColumn: 'ts', syncable: true },
  heart_rate: { timeColumn: 'ts', syncable: true },
  spo2: { timeColumn: 'ts', syncable: true },
  temperature: { timeColumn: 'ts', syncable: true },
  activity: { timeColumn: 'ts', syncable: true },
  activity_bucket: { timeColumn: 'ts', syncable: true },
  sleep_session: { timeColumn: 'ts_start', syncable: true },
  sleep_stage: { timeColumn: 'ts', syncable: true },
  sleep_raw: { timeColumn: 'ts', syncable: true },
  device_event: { timeColumn: 'ts', syncable: true },
  device_battery: { timeColumn: 'ts', syncable: true },
  device_config: { timeColumn: 'valid_from', syncable: true },
  insight: { timeColumn: 'ts', syncable: true },
  sync_watermark: { timeColumn: 'updated_at', syncable: false },
  tool_call_audit: { timeColumn: 'ts', syncable: false },
})

/**
 * Resolve the sync watermark column for a table.
 *
 * Falls back to `'ts'` for unknown table names so downstream callers stay
 * compatible if the schema catalog and this registry drift.
 */
export function timeColumnFor(table: TableName | string): string {
  return (TABLE_METADATA as Record<string, TableSyncMetadata>)[table]?.timeColumn ?? 'ts'
}

/**
 * Whether a table participates in R2 push/fetch. `false` for warehouse-local
 * tables that carry no cross-device state (`sync_watermark`,
 * `tool_call_audit`).
 */
export function isSyncable(table: TableName | string): boolean {
  return (TABLE_METADATA as Record<string, TableSyncMetadata>)[table]?.syncable ?? false
}
