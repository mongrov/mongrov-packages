/**
 * The health pack's tables: ring readings, sleep and device state.
 *
 * DDL verbatim from the package's former `SCHEMAS` (analytics-core spec
 * §Table schema). Names and columns are unchanged (package-separation R3),
 * so an existing install needs no data migration.
 */

import type { PackTable } from '../../../core/packs'

/** Health tables, in creation order. */
export const HEALTH_TABLE_NAMES = [
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
] as const

export type HealthTableName = (typeof HEALTH_TABLE_NAMES)[number]

/** Remote (Iceberg) DDL per health table. */
export const HEALTH_SCHEMAS: Readonly<Record<HealthTableName, string>> = Object.freeze({
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
  -- DECIMAL, not an integer type. The current ring emits whole degrees and
  -- the mapper stores them verbatim, which made INTEGER look free — but
  -- sprint6 specifies a user-settable flag level of 37.5 C over a 37.2-38.1
  -- range, and against an integer column every value in that range rounds to
  -- 37 or 38. Measured: thresholds 37.2 and 37.9 select identical rows, so
  -- the control has two states rather than a range. It also forecloses the
  -- 0.1 C next-gen rings that sprint6 SS7 plans a precision gate for.
  --
  -- 4 digits, 1 decimal: -999.9 to 999.9, far past any body temperature.
  temp_c DECIMAL(4,1) NOT NULL
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
  night_of DATE,
  settle_min INTEGER,
  recovered_min INTEGER
) PARTITIONED BY (day(ts_start), user_id);`,

  sleep_stage: `CREATE TABLE sleep_stage (
  ts TIMESTAMP NOT NULL,
  session_id VARCHAR NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  device_id VARCHAR NOT NULL,
  stage INTEGER NOT NULL,
  confidence DOUBLE,
  source VARCHAR
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

  // Sprint 5 §2 — `metric VARCHAR`, not the firmware's `data_type` integer.
  // Principle 21: firmware enums never leak into the schema. The mapper
  // translates `dataType` (1=heartRate, 2=spo2, 3=temperature, 4=HRV per
  // the JStyle J2301A SDK) at the ingestion boundary.
  device_config: `CREATE TABLE device_config (
  device_id VARCHAR NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  metric VARCHAR NOT NULL,
  interval_minutes INTEGER NOT NULL,
  start_time VARCHAR,
  end_time VARCHAR,
  weeks INTEGER,
  valid_from TIMESTAMP NOT NULL,
  valid_to TIMESTAMP,
  PRIMARY KEY (device_id, metric, valid_from)
);`,
})

/**
 * What identifies a row, per table (principle 66).
 *
 * Re-syncing the same data must be a no-op rather than an append. Ten of the
 * twelve sync-written tables had no key at all, so a repeated sync silently
 * duplicated — measured on device as `sleep_stage` 16399 rows for `sleep_raw`
 * 2082 blocks, which then skews the percentiles in `user_baseline`.
 *
 * The tenant triple is spelled out rather than relying on `device_id` to imply
 * it (principle 26 derives device_id from brand + hardware_id, so brand IS
 * recoverable). A key whose scope you have to derive from another principle is
 * one someone will get wrong later.
 *
 * LOCAL ONLY. These become `PRIMARY KEY` in the local DDL; the Iceberg
 * variant is untouched, matching migration 5's rule that the client never
 * destructively rewrites the attached remote catalog.
 *
 * Absent on purpose: `sleep_session`, `device_config` — already carry their
 * own PRIMARY KEY.
 */
export const HEALTH_IDENTITY_COLUMNS: Readonly<Partial<Record<HealthTableName, readonly string[]>>>
  = Object.freeze({
    // One reading per device per instant.
    hrv: ['brand', 'family_id', 'user_id', 'device_id', 'ts'],
    heart_rate: ['brand', 'family_id', 'user_id', 'device_id', 'ts'],
    spo2: ['brand', 'family_id', 'user_id', 'device_id', 'ts'],
    temperature: ['brand', 'family_id', 'user_id', 'device_id', 'ts'],
    activity: ['brand', 'family_id', 'user_id', 'device_id', 'ts'],
    activity_bucket: ['brand', 'family_id', 'user_id', 'device_id', 'ts'],
    device_battery: ['brand', 'family_id', 'user_id', 'device_id', 'ts'],
    // `event_type` is part of identity: a sync_completed and a battery_low can
    // legitimately share a timestamp.
    device_event: ['brand', 'family_id', 'user_id', 'device_id', 'ts', 'event_type'],
    // A stage belongs to a session; the session is part of what identifies it.
    sleep_stage: ['brand', 'family_id', 'user_id', 'device_id', 'session_id', 'ts'],
    sleep_raw: ['brand', 'family_id', 'user_id', 'device_id', 'ts_session_start', 'ts'],
  })

/**
 * Health tables read through a `v_{table}` union view (Sprint 5 §3).
 * `sleep_raw` and `device_config` are read directly.
 */
export const HEALTH_VIEWED_TABLES = [
  'hrv',
  'heart_rate',
  'spo2',
  'temperature',
  'activity',
  'activity_bucket',
  'sleep_session',
  'sleep_stage',
  'device_event',
  'device_battery',
] as const satisfies readonly HealthTableName[]

/**
 * Push/fetch watermark column: `ts`, except `sleep_session` (`ts_start`,
 * its partition column) and `device_config` (SCD-2, `valid_from`).
 */
const TIME_COLUMN: Readonly<Partial<Record<HealthTableName, string>>> = {
  sleep_session: 'ts_start',
  device_config: 'valid_from',
}

/** Retention: every reading table follows the effective days; `device_config` is never swept. */
const RETENTION_TS: Readonly<Partial<Record<HealthTableName, string | null>>> = {
  sleep_session: 'ts_end',
  device_config: null,
}

const viewed = new Set<string>(HEALTH_VIEWED_TABLES)

/** The pack's table declarations. */
export const HEALTH_TABLES: Readonly<Record<HealthTableName, PackTable>> = Object.freeze(
  Object.fromEntries(HEALTH_TABLE_NAMES.map((name) => {
    const retentionTs = RETENTION_TS[name] === undefined ? 'ts' : RETENTION_TS[name]
    const table: PackTable = {
      ddl: HEALTH_SCHEMAS[name],
      timeColumn: TIME_COLUMN[name] ?? 'ts',
      syncable: true,
      retention: retentionTs ? { tsColumn: retentionTs, kind: 'sensor' } : null,
      identity: HEALTH_IDENTITY_COLUMNS[name],
      view: viewed.has(name),
    }
    return [name, table]
  })) as Record<HealthTableName, PackTable>,
)

export type HealthViewedTable = (typeof HEALTH_VIEWED_TABLES)[number]
