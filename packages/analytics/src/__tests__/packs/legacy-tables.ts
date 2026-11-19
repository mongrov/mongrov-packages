/**
 * The package's table constants as they were before packs (≤ 0.52), composed
 * from the health and platform packs. Kept for consumers that validate their
 * SQL against `LOCAL_SCHEMAS` / `TABLE_NAMES`; the engine itself reads the
 * pack registry. Leaves with the health pack (package-separation S-03).
 */

import { addIdentityKey, toLocalDdl } from '../../core/ddl'
import { PLATFORM_SCHEMAS, PLATFORM_TABLE_NAMES, PLATFORM_TABLES } from '../../core/platform-tables'
import { HEALTH_IDENTITY_COLUMNS, HEALTH_SCHEMAS, HEALTH_TABLE_NAMES, HEALTH_TABLES, HEALTH_VIEWED_TABLES } from './health/tables'

/** Ordered list of every warehouse table. Order = creation order. */
export const TABLE_NAMES = [...HEALTH_TABLE_NAMES, ...PLATFORM_TABLE_NAMES] as const

export type TableName = (typeof TABLE_NAMES)[number]

/** Tables never created in the attached R2 zone. */
export const LOCAL_ONLY_TABLES: ReadonlySet<TableName> = new Set<TableName>(
  PLATFORM_TABLE_NAMES.filter(t => PLATFORM_TABLES[t].localOnly),
)

/** Remote (Iceberg) DDL for every warehouse table. */
export const SCHEMAS: Readonly<Record<TableName, string>> = Object.freeze({
  ...HEALTH_SCHEMAS,
  ...PLATFORM_SCHEMAS,
})

/** What identifies a row, per table (principle 66). */
export const IDENTITY_COLUMNS: Readonly<Partial<Record<TableName, readonly string[]>>> = HEALTH_IDENTITY_COLUMNS

/** Tables exposed through a `v_{table}` union view. */
export const VIEWED_TABLES = HEALTH_VIEWED_TABLES

export type ViewedTable = (typeof VIEWED_TABLES)[number]

/** Local-catalog DDL: `PARTITIONED BY` stripped, identity key added. */
export const LOCAL_SCHEMAS: Readonly<Record<TableName, string>> = Object.freeze(
  Object.fromEntries(
    TABLE_NAMES.map(table => [table, addIdentityKey(toLocalDdl(SCHEMAS[table]), IDENTITY_COLUMNS[table])]),
  ) as Record<TableName, string>,
)

/** Push/fetch watermark column and syncability per table (≤ 0.52 `TABLE_METADATA`). */
export const TABLE_METADATA: Readonly<Record<TableName, { timeColumn: string, syncable: boolean }>> = Object.freeze(
  Object.fromEntries(
    Object.entries({ ...HEALTH_TABLES, ...PLATFORM_TABLES })
      .map(([name, t]) => [name, { timeColumn: t.timeColumn, syncable: t.syncable }]),
  ) as Record<TableName, { timeColumn: string, syncable: boolean }>,
)

// The package ledger (≤ 0.52 `MIGRATIONS` / `CURRENT_VERSION`): the health pack's.
export { HEALTH_CURRENT_VERSION as CURRENT_VERSION, HEALTH_MIGRATIONS as MIGRATIONS } from './health/migrations'
