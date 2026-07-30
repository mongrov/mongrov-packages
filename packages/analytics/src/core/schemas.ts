/**
 * Table DDL for the analytics warehouse (spec §Table schema).
 *
 * Fifteen tables, verbatim from `.specifica/features/analytics-core/spec.md`.
 * DDL strings are frozen — apps must not mutate them; migrations (T-08) own
 * schema evolution.
 *
 * Two DDL variants exist:
 * - `SCHEMAS` — for Iceberg-attached remote catalogs. Includes
 *   `PARTITIONED BY (day(ts), user_id)` clauses that Iceberg requires
 *   for partition pruning at scan time.
 * - `LOCAL_SCHEMAS` — for the app's local DuckDB catalog. Identical to
 *   `SCHEMAS` minus the `PARTITIONED BY` clauses, which plain DuckDB
 *   (non-Iceberg) rejects with a parser error. Derived from `SCHEMAS`
 *   via `toLocalDdl` at module load time so both variants stay in sync
 *   through schema changes.
 *
 * `ensureSchemas(db, catalog, schemas)` idempotently creates every table
 * inside the given catalog, rewriting `CREATE TABLE <name>` to
 * `CREATE TABLE IF NOT EXISTS <catalog>.<name>` at issue time. Callers
 * pick the variant: remote attach uses `SCHEMAS`, local mode uses
 * `LOCAL_SCHEMAS`.
 */

import { AnalyticsError } from './errors'
import type { HybridDuckDB } from './engine'

/** Ordered list of every warehouse table. Order = creation order. */
export const TABLE_NAMES = [
  'hrv',
  'heart_rate',
  'spo2',
  'temperature',
  'activity',
  'activity_bucket',
  'sleep_session',
  'sleep_stage',
  'sleep_raw',
  'device_event',
  'device_battery',
  'device_config',
  'insight',
  'sync_watermark',
  'tool_call_audit',
] as const

export type TableName = (typeof TABLE_NAMES)[number]

/**
 * Frozen DDL for every warehouse table. Copied verbatim from spec §Table
 * schema; rewrite happens in `ensureSchemas` at issue time.
 */
export const SCHEMAS: Readonly<Record<TableName, string>> = Object.freeze({
  hrv: `CREATE TABLE hrv (
  ts TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  device_id VARCHAR NOT NULL,
  hrv_ms INTEGER,
  stress INTEGER,
  systolic_bp INTEGER,
  diastolic_bp INTEGER,
  vascular_aging INTEGER
) PARTITIONED BY (day(ts), user_id);`,

  heart_rate: `CREATE TABLE heart_rate (
  ts TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  device_id VARCHAR NOT NULL,
  bpm INTEGER NOT NULL
) PARTITIONED BY (day(ts), user_id);`,

  spo2: `CREATE TABLE spo2 (
  ts TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  device_id VARCHAR NOT NULL,
  spo2 INTEGER NOT NULL
) PARTITIONED BY (day(ts), user_id);`,

  temperature: `CREATE TABLE temperature (
  ts TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  device_id VARCHAR NOT NULL,
  temp_c INTEGER NOT NULL
) PARTITIONED BY (day(ts), user_id);`,

  activity: `CREATE TABLE activity (
  ts TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  device_id VARCHAR NOT NULL,
  steps INTEGER NOT NULL
) PARTITIONED BY (day(ts), user_id);`,

  activity_bucket: `CREATE TABLE activity_bucket (
  ts TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  device_id VARCHAR NOT NULL,
  calories DOUBLE,
  distance_km DOUBLE
) PARTITIONED BY (day(ts), user_id);`,

  sleep_session: `CREATE TABLE sleep_session (
  session_id VARCHAR PRIMARY KEY,
  ts_start TIMESTAMP NOT NULL,
  ts_end TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  device_id VARCHAR NOT NULL,
  total_minutes INTEGER NOT NULL,
  deep_minutes INTEGER,
  rem_minutes INTEGER,
  light_minutes INTEGER,
  awake_minutes INTEGER,
  avg_confidence DOUBLE,
  night_of DATE
) PARTITIONED BY (day(ts_start), user_id);`,

  sleep_stage: `CREATE TABLE sleep_stage (
  ts TIMESTAMP NOT NULL,
  session_id VARCHAR NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  device_id VARCHAR NOT NULL,
  stage INTEGER NOT NULL,
  confidence DOUBLE
) PARTITIONED BY (day(ts), user_id);`,

  sleep_raw: `CREATE TABLE sleep_raw (
  ts TIMESTAMP NOT NULL,
  ts_session_start TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  device_id VARCHAR NOT NULL,
  quality INTEGER NOT NULL,
  unit_length INTEGER
) PARTITIONED BY (day(ts_session_start), user_id);`,

  device_event: `CREATE TABLE device_event (
  ts TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  device_id VARCHAR NOT NULL,
  event_type VARCHAR NOT NULL,
  payload VARCHAR
) PARTITIONED BY (day(ts));`,

  device_battery: `CREATE TABLE device_battery (
  ts TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  device_id VARCHAR NOT NULL,
  battery_pct DOUBLE NOT NULL
) PARTITIONED BY (day(ts), device_id);`,

  device_config: `CREATE TABLE device_config (
  device_id VARCHAR NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  data_type INTEGER NOT NULL,
  interval_minutes INTEGER NOT NULL,
  start_time VARCHAR,
  end_time VARCHAR,
  weeks INTEGER,
  valid_from TIMESTAMP NOT NULL,
  valid_to TIMESTAMP,
  PRIMARY KEY (device_id, data_type, valid_from)
);`,

  insight: `CREATE TABLE insight (
  id VARCHAR PRIMARY KEY,
  ts TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  rule_id VARCHAR,
  severity VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  body TEXT,
  evidence VARCHAR,
  acknowledged_at TIMESTAMP
) PARTITIONED BY (day(ts));`,

  sync_watermark: `CREATE TABLE sync_watermark (
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  table_name VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  cursor_ts TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  PRIMARY KEY (brand, family_id, table_name, kind)
);`,

  tool_call_audit: `CREATE TABLE tool_call_audit (
  ts TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  requester_user_id VARCHAR NOT NULL,
  tool_name VARCHAR NOT NULL,
  args VARCHAR NOT NULL,
  result_bytes INTEGER,
  result_row_count INTEGER,
  latency_ms INTEGER,
  outcome VARCHAR NOT NULL,
  error_message VARCHAR
) PARTITIONED BY (day(ts));`,
})

/**
 * Rewrite one base DDL to `CREATE TABLE IF NOT EXISTS <catalog>.<table>`.
 *
 * Exported for tests; call sites should prefer `ensureSchemas`.
 */
export function qualifyDdl(baseDdl: string, table: TableName, catalog: string): string {
  return baseDdl.replace(
    `CREATE TABLE ${table}`,
    `CREATE TABLE IF NOT EXISTS ${catalog}.${table}`,
  )
}

/**
 * Strip the Iceberg-only `PARTITIONED BY (...)` clause from a DDL string.
 * Plain DuckDB (non-Iceberg) rejects the clause with a parser error; local
 * mode uses the returned form. Preserves the trailing `);` terminator.
 *
 * Exported for tests; call sites should prefer `LOCAL_SCHEMAS`.
 */
export function toLocalDdl(baseDdl: string): string {
  // The clause always terminates the DDL, and its column list contains
  // nested parens (`day(ts)`), so strip from the closing table paren to
  // end-of-string rather than trying to match the paren group.
  return baseDdl.replace(/\)\s*PARTITIONED BY[\s\S]*$/, ');')
}

/**
 * Local-catalog DDL variants of `SCHEMAS` — same tables, same columns,
 * same primary keys; only difference is the `PARTITIONED BY` clauses are
 * stripped. Derived programmatically so schema changes in `SCHEMAS`
 * propagate automatically.
 */
export const LOCAL_SCHEMAS: Readonly<Record<TableName, string>> = Object.freeze(
  Object.fromEntries(
    TABLE_NAMES.map(table => [table, toLocalDdl(SCHEMAS[table])]),
  ) as Record<TableName, string>,
)

/**
 * Create every warehouse table under `<catalog>.<table>`, in `TABLE_NAMES` order.
 *
 * Idempotent — every issued statement uses `IF NOT EXISTS`. Failure at any
 * table surfaces as `AnalyticsError('migration_failed', <table>, cause)`.
 *
 * `schemas` selects the DDL variant: pass `SCHEMAS` for remote iceberg
 * catalogs (with `PARTITIONED BY`), `LOCAL_SCHEMAS` for the local DuckDB
 * catalog (without). Default is `SCHEMAS` for back-compat with 0.4.x
 * callers that only wrote to the attached remote.
 */
export async function ensureSchemas(
  db: HybridDuckDB,
  catalog: string,
  schemas: Readonly<Record<TableName, string>> = SCHEMAS,
): Promise<void> {
  for (const table of TABLE_NAMES) {
    const sql = qualifyDdl(schemas[table], table, catalog)
    try {
      await db.execute(sql)
    }
    catch (cause) {
      throw new AnalyticsError(
        'migration_failed',
        `ensureSchemas failed at table ${table}`,
        cause,
      )
    }
  }
}
