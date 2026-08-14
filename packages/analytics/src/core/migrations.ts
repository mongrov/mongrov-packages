/**
 * Schema migrations for the warehouse.
 *
 * Version is tracked per `(brand, tenantId)` in KVStore. v0.1.0 has a single
 * baseline migration (step 1: `ensureSchemas`) — future migrations append to
 * `MIGRATIONS` in order; each `up(db, catalogs)` receives the catalog set
 * for the current attach mode.
 *
 * `ensureMigrations` accepts a `MigrationCatalogs` object with:
 * - `local` — the local DuckDB catalog name (always present, from
 *   `current_database()`). LOCAL_SCHEMAS DDL runs here.
 * - `remote` — the attached R2 iceberg catalog secret name (present only
 *   in R2 mode). SCHEMAS (with `PARTITIONED BY`) DDL runs here.
 *
 * The baseline migration ensures BOTH sets get created when both catalogs
 * are present. Local-mode installs run just the LOCAL_SCHEMAS half. R2
 * installs run both halves — fixing the pre-0.5.0 gap where `local.*`
 * tables never got created and the sink threw on first append.
 *
 * `ensureMigrations` is idempotent and safe to call on every attach.
 */

import type { HybridDuckDB } from './engine'
import type { TableName } from './schemas'
import type { KVStore } from './types'
import { AnalyticsError } from './errors'
import { ensureSchemas, IDENTITY_COLUMNS, insightIndexDdl, LOCAL_SCHEMAS, qualifyDdl, quoteQualifier, SCHEMAS } from './schemas'

export interface MigrationContext {
  brand: string
  tenantId: string
}

export interface MigrationCatalogs {
  /** Local DuckDB catalog name (e.g. `memory` in tests, `<filestem>` on device). */
  local: string
  /** Attached R2 iceberg catalog secret name. Undefined in local mode. */
  remote?: string
}

/**
 * Iceberg namespace remote DDL is issued under — remote tables live at
 * `<secret>.default.<table>` (spec §Attach Protocol). Local DDL stays
 * 2-part because the local catalog's default schema resolves implicitly.
 */
export const REMOTE_NAMESPACE = 'default'

export interface Migration {
  /** Sequential integer, starting at 1. */
  version: number
  /** Human name shown in errors + logs. */
  name: string
  /** Idempotent DDL — called with the current attach's catalog set. */
  up: (db: HybridDuckDB, catalogs: MigrationCatalogs) => Promise<void>
}

/**
 * Ordered list of migrations. Each entry's `version` must equal its
 * (1-based) position; `CURRENT_VERSION` is derived from the tail.
 */
/**
 * Column names for a table, without touching `information_schema`.
 *
 * `information_schema.columns` is a view in DuckDB's `system` catalog, and
 * the react-native-duckdb iOS build cannot resolve it:
 *
 *   Binder Error: Referenced table "system" not found!
 *
 * `PRAGMA table_info` answers the same question through the pragma
 * interface, which does not bind a catalog. A missing table throws there, and
 * an empty list is exactly what callers use to mean "table absent", so that
 * case is normalised rather than propagated.
 */
async function listColumns(
  db: HybridDuckDB,
  catalog: string,
  table: string,
): Promise<string[]> {
  const qualified = `${quoteQualifier(catalog)}.${table}`
  try {
    const rows = await db.execute<{ name?: string, column_name?: string }>(
      `PRAGMA table_info('${qualified}');`,
    )
    return rows
      .map((r: { name?: string, column_name?: string }) => r.name ?? r.column_name)
      .filter((n: string | undefined): n is string => typeof n === 'string')
  }
  catch {
    // Either the table does not exist, or this build has no table_info.
    // Fall back to information_schema for platforms where it works.
    try {
      const rows = await db.execute<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns `
        + `WHERE table_catalog = $catalog AND table_name = $table`,
        { catalog, table },
      )
      return rows.map((r: { column_name: string }) => r.column_name)
    }
    catch {
      return []
    }
  }
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: 'baseline schemas',
    async up(db, catalogs) {
      // Always ensure local tables (LOCAL_SCHEMAS — no PARTITIONED BY;
      // plain DuckDB accepts the DDL). 2-part `<catalog>.<table>` resolves
      // via the local catalog's default `main` schema.
      await ensureSchemas(db, catalogs.local, LOCAL_SCHEMAS)
      // Ensure remote tables when attached to R2 (SCHEMAS — with
      // PARTITIONED BY; Iceberg requires it). Since 0.5.0 dropped the
      // `USE <catalog>.default` step, remote DDL must spell the Iceberg
      // namespace explicitly — 2-part `zone_x.<table>` fails with
      // "Schema with name ... not found" on an attached Iceberg catalog.
      if (catalogs.remote) {
        await ensureSchemas(
          db,
          `${quoteQualifier(catalogs.remote)}.${REMOTE_NAMESPACE}`,
          SCHEMAS,
          { skipLocalOnly: true },
        )
      }
    },
  },
  {
    version: 2,
    name: 'device_battery table',
    // Dedicated numeric table for battery samples (fix option B2). The
    // pre-0.6.0 `device_battery` metric pointed at `device_event.payload`
    // (JSON VARCHAR) — rules compiled but compared strings to numbers
    // across every event type, so they could never fire correctly.
    // Installs that ran step 1 on ≥0.6.0 already have the table from the
    // baseline `ensureSchemas` (IF NOT EXISTS makes this a no-op there).
    async up(db, catalogs) {
      await db.execute(qualifyDdl(LOCAL_SCHEMAS.device_battery, 'device_battery', catalogs.local))
      if (catalogs.remote) {
        await db.execute(qualifyDdl(SCHEMAS.device_battery, 'device_battery', `${quoteQualifier(catalogs.remote)}.${REMOTE_NAMESPACE}`))
      }
    },
  },
  {
    version: 3,
    name: 'insight v2 (insight_id / metric / kind / dismissed_at)',
    // Fix CO-2: the pre-0.7.0 `insight` table used an `id` PK and lacked
    // the spec's `metric`, `kind`, and `dismissed_at` columns, so the
    // registry contract (queries.ts worthALookInsight) could never match.
    // Recreates the LOCAL table to the spec shape, preserving rows:
    //   id → insight_id, kind defaults to 'threshold', severity
    //   'critical' → 'urgent' (spec enum is info|warn|urgent).
    // Idempotent: skips the recreate when `metric` is already present
    // (fresh installs get the new shape from the baseline ensureSchemas).
    // The remote zone gets CREATE IF NOT EXISTS only — the client never
    // destructively rewrites the attached Iceberg catalog; schema
    // evolution of pre-existing remote tables is a server-side operation.
    async up(db, catalogs) {
      const cols = await listColumns(db, catalogs.local, 'insight')
      const hasMetric = cols.includes('metric')
      if (!hasMetric) {
        // Re-entrancy: a prior partially-failed run may have left the
        // scratch table behind (KV only advances after full success).
        await db.execute(`DROP TABLE IF EXISTS ${quoteQualifier(catalogs.local)}.insight_v2;`)
        const tmpDdl = LOCAL_SCHEMAS.insight.replace(
          'CREATE TABLE insight',
          `CREATE TABLE ${quoteQualifier(catalogs.local)}.insight_v2`,
        )
        await db.execute(tmpDdl)
        // Old rows had no metric column; the package never wrote rows
        // pre-v2 (rules only emitted events), so 'unknown' only tags
        // app-authored legacy rows.
        await db.execute(
          `INSERT INTO ${quoteQualifier(catalogs.local)}.insight_v2 `
          + `(insight_id, ts, brand, family_id, user_id, rule_id, metric, kind, `
          + `severity, title, body, evidence, acknowledged_at, dismissed_at) `
          + `SELECT id, ts, brand, family_id, user_id, rule_id, 'unknown', 'threshold', `
          + `CASE WHEN severity = 'critical' THEN 'urgent' ELSE severity END, `
          + `title, body, evidence, acknowledged_at, NULL `
          + `FROM ${quoteQualifier(catalogs.local)}.insight;`,
        )
        await db.execute(`DROP TABLE ${quoteQualifier(catalogs.local)}.insight;`)
        await db.execute(`ALTER TABLE ${quoteQualifier(catalogs.local)}.insight_v2 RENAME TO insight;`)
      }
      await db.execute(insightIndexDdl(catalogs.local))
      if (catalogs.remote) {
        await db.execute(qualifyDdl(SCHEMAS.insight, 'insight', `${quoteQualifier(catalogs.remote)}.${REMOTE_NAMESPACE}`))
      }
    },
  },
  {
    version: 4,
    name: 'user_baseline table (Sprint 5 §7)',
    // Shared day-first baseline store for rules, tools, and screens.
    //
    // NOTE ON NUMBERING: the Sprint 5 spec (§33 / tasks T-03) calls this
    // "migration v3". Versions 2 and 3 were already spent on the
    // device_battery table and the insight v2 rebuild before Sprint 5
    // started, so it lands at 4 instead. Same for the spec's "migration v4"
    // (insight.dismissed_at), which is already satisfied — the column ships
    // in the baseline DDL and step 3 backfills it, so no ALTER is needed.
    //
    // Local-only: baselines are derived from local+R2 union views and are
    // cheap to recompute, so there is no value in pushing them to R2 and
    // no correctness story for two devices racing to write the same row.
    async up(db, catalogs) {
      await db.execute(
        qualifyDdl(LOCAL_SCHEMAS.user_baseline, 'user_baseline', catalogs.local),
      )
    },
  },
  {
    version: 5,
    name: 'device_config: data_type -> metric (Sprint 5 §2)',
    // Principle 21 — firmware enums do not belong in the schema. Converts
    // existing rows using the JStyle J2301A automatic-monitoring enum
    // (1=heartRate, 2=spo2, 3=temperature, 4=HRV), which is what the old
    // `data_type` column actually held.
    //
    // Numbered 5, not the spec's 2: versions 2-4 were spent before this
    // landed (device_battery, insight v2, user_baseline).
    //
    // Idempotent: skips when `metric` already exists. Local only — the
    // client never destructively rewrites the attached Iceberg catalog;
    // remote schema evolution is a server-side operation.
    async up(db, catalogs) {
      const cols = await listColumns(db, catalogs.local, 'device_config')
      if (cols.length === 0)
        return // table absent; baseline will create it
      if (cols.includes('metric'))
        return

      await db.execute(`DROP TABLE IF EXISTS ${quoteQualifier(catalogs.local)}.device_config_v2;`)
      const tmpDdl = LOCAL_SCHEMAS.device_config.replace(
        'CREATE TABLE device_config',
        `CREATE TABLE ${quoteQualifier(catalogs.local)}.device_config_v2`,
      )
      await db.execute(tmpDdl)
      await db.execute(
        `INSERT INTO ${quoteQualifier(catalogs.local)}.device_config_v2 `
        + `(device_id, brand, family_id, user_id, metric, interval_minutes, `
        + `start_time, end_time, weeks, valid_from, valid_to) `
        + `SELECT device_id, brand, family_id, user_id, `
        + `CASE data_type WHEN 1 THEN 'heart_rate' WHEN 2 THEN 'spo2' `
        + `WHEN 3 THEN 'temperature' WHEN 4 THEN 'hrv' `
        // Unknown codes are preserved rather than dropped, so a firmware
        // revision that added one is diagnosable instead of invisible.
        + `ELSE 'unknown_' || data_type::VARCHAR END, `
        + `interval_minutes, start_time, end_time, weeks, valid_from, valid_to `
        + `FROM ${quoteQualifier(catalogs.local)}.device_config;`,
      )
      await db.execute(`DROP TABLE ${quoteQualifier(catalogs.local)}.device_config;`)
      await db.execute(
        `ALTER TABLE ${quoteQualifier(catalogs.local)}.device_config_v2 RENAME TO device_config;`,
      )
    },
  },
  {
    version: 6,
    name: 'identity keys on sync-written tables (principle 66)',
    // Ten of the twelve sync-written tables had no key, so re-syncing the
    // same data appended silently — measured on device as `sleep_stage`
    // 16399 rows for `sleep_raw` 2082 blocks, which then skews the
    // percentiles in `user_baseline`.
    //
    // Existing installs already hold those duplicates, so the constraint
    // cannot simply be added: it would fail on the first user who has them.
    // The rebuild dedupes as it copies, using the new key itself to do the
    // work — `ON CONFLICT DO NOTHING` against the v2 table keeps the first
    // row of each identity tuple and drops the rest.
    //
    // Local only. The client never destructively rewrites the attached
    // Iceberg catalog (same rule as migration 5), and `IDENTITY_COLUMNS`
    // is applied to `LOCAL_SCHEMAS` alone.
    async up(db, catalogs) {
      const local = quoteQualifier(catalogs.local)

      for (const table of Object.keys(IDENTITY_COLUMNS) as TableName[]) {
        const cols = await listColumns(db, catalogs.local, table)
        if (cols.length === 0)
          continue // table absent; migration 1 will create it with the key

        // Column list is spelled out rather than `SELECT *` so a future
        // column reorder cannot silently shift values between columns.
        const columnList = cols.join(', ')

        await db.execute(`DROP TABLE IF EXISTS ${local}.${table}_v2;`)
        await db.execute(
          LOCAL_SCHEMAS[table].replace(
            `CREATE TABLE ${table}`,
            `CREATE TABLE ${local}.${table}_v2`,
          ),
        )
        await db.execute(
          `INSERT INTO ${local}.${table}_v2 (${columnList}) `
          + `SELECT ${columnList} FROM ${local}.${table} `
          + `ON CONFLICT DO NOTHING;`,
        )
        await db.execute(`DROP TABLE ${local}.${table};`)
        await db.execute(`ALTER TABLE ${local}.${table}_v2 RENAME TO ${table};`)
      }
    },
  },
  {
    version: 7,
    name: 'temperature.temp_c INTEGER -> DECIMAL(4,1) (sprint6 T-01 finding)',
    // The column was INTEGER because the current ring emits whole degrees.
    // sprint6 then specified a user-settable flag level of 37.5 C over a
    // 37.2-38.1 range, which an integer column cannot represent: measured,
    // thresholds 37.2 and 37.9 select identical rows, so the control has two
    // states rather than a range.
    //
    // Widening only — every stored integer is representable as DECIMAL(4,1),
    // so the copy is lossless and the migration is safe to re-run.
    //
    // Local only. An attached Iceberg catalog created before this still has
    // the integer column; the union view coerces on read, but PUSHING
    // decimals into it would truncate. Cloud sync is off today, which is the
    // window to evolve the remote schema server-side — see the note in the
    // sprint6 propose-diff.
    async up(db, catalogs) {
      const local = quoteQualifier(catalogs.local)
      const cols = await listColumns(db, catalogs.local, 'temperature')
      if (cols.length === 0)
        return // table absent; migration 1 creates it with the new type

      const columnList = cols.join(', ')
      await db.execute(`DROP TABLE IF EXISTS ${local}.temperature_v2;`)
      await db.execute(
        LOCAL_SCHEMAS.temperature.replace(
          'CREATE TABLE temperature',
          `CREATE TABLE ${local}.temperature_v2`,
        ),
      )
      await db.execute(
        `INSERT INTO ${local}.temperature_v2 (${columnList}) `
        + `SELECT ${columnList} FROM ${local}.temperature ON CONFLICT DO NOTHING;`,
      )
      await db.execute(`DROP TABLE ${local}.temperature;`)
      await db.execute(`ALTER TABLE ${local}.temperature_v2 RENAME TO temperature;`)
    },
  },
])

/** Version of the latest known migration — target for every attach. */
export const CURRENT_VERSION: number = MIGRATIONS.length

/**
 * Compute the KV key holding the applied schema version for a
 * `(brand, tenantId)` pair.
 */
export function schemaVersionKey(brand: string, tenantId: string): string {
  return `analytics:schema_version:${brand}:${tenantId}`
}

/**
 * Legacy KV key format used before T-23 canonicalization (hyphen instead
 * of underscore). Read-only — `ensureMigrations` copies any legacy entry
 * to the canonical key on first read and deletes the legacy one.
 */
function legacySchemaVersionKey(brand: string, tenantId: string): string {
  return `analytics:schema-version:${brand}:${tenantId}`
}

export interface EnsureMigrationsResult {
  from: number
  to: number
}

/**
 * Run every migration between the persisted version and `CURRENT_VERSION`.
 *
 * - First launch: `from = 0`, applies every migration.
 * - Same-version rerun: no-op, KV unchanged, returns `from === to`.
 * - Upgrade path: applies only newer migrations in order.
 * - Any failure at step N surfaces as
 *   `AnalyticsError('migration_failed', 'step-<n>', cause)`. KV is only
 *   advanced after each successful step so a partial upgrade leaves the
 *   version at the last successful step (subsequent runs retry from there).
 */
export async function ensureMigrations(
  db: HybridDuckDB,
  kv: KVStore,
  ctx: MigrationContext,
  catalogs: MigrationCatalogs,
): Promise<EnsureMigrationsResult> {
  const key = schemaVersionKey(ctx.brand, ctx.tenantId)
  let stored = await kv.get<number>(key)

  // One-shot migration from the pre-T-23 hyphenated key. If the canonical
  // key is absent but a legacy value exists, adopt it under the new key
  // and remove the legacy entry so this branch stays cold on next boot.
  if (stored === undefined) {
    const legacyKey = legacySchemaVersionKey(ctx.brand, ctx.tenantId)
    const legacyValue = await kv.get<number>(legacyKey)
    if (typeof legacyValue === 'number') {
      await kv.set(key, legacyValue)
      await kv.delete(legacyKey)
      stored = legacyValue
    }
  }

  const from = typeof stored === 'number' ? stored : 0

  if (from >= CURRENT_VERSION) {
    return { from, to: from }
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) {
      continue
    }
    try {
      await migration.up(db, catalogs)
    }
    catch (cause) {
      throw new AnalyticsError(
        'migration_failed',
        `migration step-${migration.version} (${migration.name}) failed`,
        cause,
      )
    }
    await kv.set(key, migration.version)
  }

  return { from, to: CURRENT_VERSION }
}
