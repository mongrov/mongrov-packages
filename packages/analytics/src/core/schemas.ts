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

import type { HybridDuckDB } from './engine'
import { AnalyticsError } from './errors'

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
  'user_baseline',
] as const

export type TableName = (typeof TABLE_NAMES)[number]

/**
 * Tables that exist only in the local catalog and are never created in the
 * attached R2 zone.
 *
 * `user_baseline` is derived data: it is recomputed from the union views
 * after each sync cycle and is cheap to rebuild, so pushing it would add an
 * Iceberg table nobody reads and invite two devices in the same family to
 * race on the same composite PK.
 *
 * `sync_watermark` is deliberately NOT here, despite being per-device
 * bookkeeping that is never pushed (`TABLE_METADATA.syncable: false`).
 * Excluding it broke the T-18 retention integration cases, which exercise
 * the sweep against the real attached Iceberg catalog and need the table
 * present there. An empty remote copy is harmless; a failing sweep is not.
 */
export const LOCAL_ONLY_TABLES: ReadonlySet<TableName> = new Set<TableName>([
  'user_baseline',
])

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

  insight: `CREATE TABLE insight (
  insight_id VARCHAR PRIMARY KEY,
  ts TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  rule_id VARCHAR,
  metric VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  severity VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  body TEXT,
  evidence VARCHAR,
  acknowledged_at TIMESTAMP,
  dismissed_at TIMESTAMP
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

  // Sprint 5 §7 — shared baseline source of truth for rules, tools, and
  // screens. Quantiles are computed DAY-FIRST (principle 27): readings
  // collapse to one value per local day, then quantiles run across days.
  // `sample_count` therefore counts DAYS, not readings — a row is only
  // written at >= 20 days (BASELINE_MIN_DAYS).
  //
  // Not partitioned: the table holds at most
  // (metrics x windows) = 21 rows per user, and the composite PK is the
  // only access path any consumer uses.
  user_baseline: `CREATE TABLE user_baseline (
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  metric VARCHAR NOT NULL,
  window_days SMALLINT NOT NULL,
  p05 DOUBLE,
  p10 DOUBLE,
  p50 DOUBLE,
  p90 DOUBLE,
  p95 DOUBLE,
  mean DOUBLE,
  stddev DOUBLE,
  sample_count INTEGER,
  computed_at TIMESTAMP NOT NULL,
  PRIMARY KEY (brand, family_id, user_id, metric, window_days)
);`,
})

/**
 * Lookup index for the `insight` table (spec §Table schema). Local catalog
 * only — Iceberg has no CREATE INDEX; remote-side query pruning comes from
 * the `day(ts)` partition instead. Issued by migration step 3.
 */
export function insightIndexDdl(catalog: string): string {
  return `CREATE INDEX IF NOT EXISTS idx_insight_lookup ON ${quoteQualifier(catalog)}.insight (user_id, metric, dismissed_at, ts);`
}

/**
 * Sensor tables exposed through a `v_{table}` union view (Sprint 5 §3).
 *
 * Registry queries, rule SQL, and tool SQL all target `v_{table}` and never
 * `local.{table}` or `r2.default.{table}` directly (principle 19). Internal
 * tables are absent deliberately: `insight`, `sync_watermark`,
 * `tool_call_audit`, `user_baseline` and `device_config` are local-authoritative
 * or local-only, so a union would either duplicate rows or read a remote
 * copy that is never authoritative.
 */
export const VIEWED_TABLES = [
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
] as const

export type ViewedTable = (typeof VIEWED_TABLES)[number]

/** Timestamp column the watermark partitions on, per table. */
export function watermarkColumnFor(table: ViewedTable): string {
  return table === 'sleep_session' ? 'ts_start' : 'ts'
}

/**
 * Build the `CREATE OR REPLACE VIEW v_{table}` DDL for one sensor table.
 *
 * The view is what makes freshness honest: rows the device has flushed
 * locally but not yet pushed to R2 are invisible in `r2.default.{table}`,
 * and rows already pushed exist in BOTH catalogs. The push watermark
 * partitions the two sources exactly —
 *
 *   local:  rows strictly AFTER the watermark  (not yet pushed)
 *   remote: everything                          (pushed)
 *
 * — so the union is complete with no duplicates at the boundary, and a row
 * becomes remote-visible at the same instant it stops being local-visible.
 *
 * The watermark subquery reads `sync_watermark` rather than taking a bound
 * parameter because DuckDB views cannot close over query-time params; the
 * view must resolve the current cursor on every scan. `$brand` /
 * `$family_id` are likewise unavailable inside a view body, so the tenant
 * filter is baked in at creation time from the attach context — which is
 * safe precisely because views are dropped and recreated on every attach
 * (T-06), so a brand switch cannot leave a view scoped to the old tenant.
 *
 * `remoteCatalog` omitted (local mode) produces a local-only view with no
 * UNION, so consumers write one SQL string that works in both modes.
 */
export function generateViewDdl(
  table: ViewedTable,
  ctx: { brand: string, familyId: string, localCatalog: string, remoteCatalog?: string },
): string {
  const tsCol = watermarkColumnFor(table)
  const brand = sqlLiteral(ctx.brand)
  const familyId = sqlLiteral(ctx.familyId)
  const localCatalog = quoteQualifier(ctx.localCatalog)
  const local = `${localCatalog}.${table}`

  const watermark
    = `COALESCE((SELECT cursor_ts FROM ${localCatalog}.sync_watermark `
      + `WHERE table_name = '${table}' AND kind = 'push' `
      + `AND brand = ${brand} AND family_id = ${familyId}), `
      + `'1970-01-01'::TIMESTAMP)`

  if (!ctx.remoteCatalog) {
    // Local mode: nothing is ever pushed, so every local row is visible and
    // the watermark filter would be a no-op that only costs a scan.
    return `CREATE OR REPLACE VIEW v_${table} AS SELECT * FROM ${local};`
  }

  const remote = `${quoteQualifier(ctx.remoteCatalog)}.${REMOTE_NAMESPACE_VIEW}.${table}`
  return (
    `CREATE OR REPLACE VIEW v_${table} AS\n`
    + `  SELECT * FROM ${local}\n`
    + `  WHERE ${tsCol} > ${watermark}\n`
    + `  UNION ALL\n`
    + `  SELECT * FROM ${remote};`
  )
}

/**
 * Iceberg namespace remote tables live under. Duplicated from
 * `migrations.ts` rather than imported to keep `schemas.ts` free of a
 * migrations dependency (migrations already imports schemas).
 */
const REMOTE_NAMESPACE_VIEW = 'default'

/**
 * Single-quote a SQL string literal. View bodies cannot take bound
 * parameters, so brand/familyId are inlined — escaping is mandatory, not
 * optional, even though both values are server-issued.
 */
const SINGLE_QUOTE_RE = /'/g
const BARE_IDENT_RE = /^[A-Z_]\w*$/i
const PARTITIONED_BY_TAIL_RE = /\)\s*PARTITIONED BY[\s\S]*$/

function sqlLiteral(value: string): string {
  return `'${value.replace(SINGLE_QUOTE_RE, `''`)}'`
}

/** `DROP VIEW IF EXISTS v_{table}` for detach + brand switch. */
export function dropViewDdl(table: ViewedTable): string {
  return `DROP VIEW IF EXISTS v_${table};`
}

/**
 * Quote a (possibly dotted) SQL qualifier for use in DDL/DML.
 *
 * Catalog names come from the database filename, so `zivaone-analytics.duckdb`
 * yields the catalog `zivaone-analytics` — and a bare hyphen is a syntax
 * error in an identifier position:
 *
 *   CREATE TABLE IF NOT EXISTS zivaone-analytics.hrv (...)
 *                                      ^ Parser Error: syntax error at or near "-"
 *
 * Each dot-separated part is quoted independently, because callers pass both
 * plain catalogs (`memory`) and qualified namespaces (`remote.analytics`).
 * Parts that are already quoted are left alone, and embedded double quotes
 * are doubled per SQL rules.
 */
export function quoteQualifier(qualifier: string): string {
  return qualifier
    .split('.')
    .map((part) => {
      if (part.startsWith('"') && part.endsWith('"'))
        return part
      // Leave plain identifiers bare. Quoting everything would work, but it
      // churns every emitted statement and makes the SQL harder to read for
      // the common `memory` / `main` case; only names that actually need it
      // get quoted.
      if (BARE_IDENT_RE.test(part))
        return part
      return `"${part.split('"').join('""')}"`
    })
    .join('.')
}

/**
 * Rewrite one base DDL to `CREATE TABLE IF NOT EXISTS <catalog>.<table>`.
 *
 * Exported for tests; call sites should prefer `ensureSchemas`.
 */
export function qualifyDdl(baseDdl: string, table: TableName, catalog: string): string {
  return baseDdl.replace(
    `CREATE TABLE ${table}`,
    `CREATE TABLE IF NOT EXISTS ${quoteQualifier(catalog)}.${table}`,
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
  return baseDdl.replace(PARTITIONED_BY_TAIL_RE, ');')
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
  opts: { skipLocalOnly?: boolean } = {},
): Promise<void> {
  for (const table of TABLE_NAMES) {
    // Remote passes `skipLocalOnly` so derived/bookkeeping tables never get
    // created in the user's R2 zone.
    if (opts.skipLocalOnly && LOCAL_ONLY_TABLES.has(table)) {
      continue
    }
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
