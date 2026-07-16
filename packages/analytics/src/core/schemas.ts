/**
 * Table DDL for the analytics warehouse (spec §Table schema).
 *
 * Fourteen tables, verbatim from `.specifica/features/analytics-core/spec.md`.
 * DDL strings are frozen — apps must not mutate them; migrations (T-08) own
 * schema evolution.
 *
 * `ensureSchemas(db, catalog)` idempotently creates every table inside the
 * attached catalog (i.e. `zone_<tenantId>`), rewriting `CREATE TABLE <name>`
 * to `CREATE TABLE IF NOT EXISTS <catalog>.<name>` at issue time so the base
 * DDL stays faithful to the spec text.
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
 * Create every warehouse table under `<catalog>.<table>`, in `TABLE_NAMES` order.
 *
 * Idempotent — every issued statement uses `IF NOT EXISTS`. Failure at any
 * table surfaces as `AnalyticsError('migration_failed', <table>, cause)`.
 */
export async function ensureSchemas(db: HybridDuckDB, catalog: string): Promise<void> {
  for (const table of TABLE_NAMES) {
    const sql = qualifyDdl(SCHEMAS[table], table, catalog)
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
