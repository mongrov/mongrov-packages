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

import { AnalyticsError } from './errors'
import type { HybridDuckDB } from './engine'
import { ensureSchemas, insightIndexDdl, LOCAL_SCHEMAS, qualifyDdl, SCHEMAS } from './schemas'
import type { KVStore } from './types'

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
  up(db: HybridDuckDB, catalogs: MigrationCatalogs): Promise<void>
}

/**
 * Ordered list of migrations. Each entry's `version` must equal its
 * (1-based) position; `CURRENT_VERSION` is derived from the tail.
 */
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
          `${catalogs.remote}.${REMOTE_NAMESPACE}`,
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
        await db.execute(qualifyDdl(SCHEMAS.device_battery, 'device_battery', `${catalogs.remote}.${REMOTE_NAMESPACE}`))
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
      const cols = await db.execute<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns `
        + `WHERE table_catalog = $catalog AND table_name = 'insight'`,
        { catalog: catalogs.local },
      )
      const hasMetric = cols.some(c => c.column_name === 'metric')
      if (!hasMetric) {
        // Re-entrancy: a prior partially-failed run may have left the
        // scratch table behind (KV only advances after full success).
        await db.execute(`DROP TABLE IF EXISTS ${catalogs.local}.insight_v2;`)
        const tmpDdl = LOCAL_SCHEMAS.insight.replace(
          'CREATE TABLE insight',
          `CREATE TABLE ${catalogs.local}.insight_v2`,
        )
        await db.execute(tmpDdl)
        // Old rows had no metric column; the package never wrote rows
        // pre-v2 (rules only emitted events), so 'unknown' only tags
        // app-authored legacy rows.
        await db.execute(
          `INSERT INTO ${catalogs.local}.insight_v2 `
          + `(insight_id, ts, brand, family_id, user_id, rule_id, metric, kind, `
          + `severity, title, body, evidence, acknowledged_at, dismissed_at) `
          + `SELECT id, ts, brand, family_id, user_id, rule_id, 'unknown', 'threshold', `
          + `CASE WHEN severity = 'critical' THEN 'urgent' ELSE severity END, `
          + `title, body, evidence, acknowledged_at, NULL `
          + `FROM ${catalogs.local}.insight;`,
        )
        await db.execute(`DROP TABLE ${catalogs.local}.insight;`)
        await db.execute(`ALTER TABLE ${catalogs.local}.insight_v2 RENAME TO insight;`)
      }
      await db.execute(insightIndexDdl(catalogs.local))
      if (catalogs.remote) {
        await db.execute(qualifyDdl(SCHEMAS.insight, 'insight', `${catalogs.remote}.${REMOTE_NAMESPACE}`))
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
      const cols = await db.execute<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns `
        + `WHERE table_catalog = $catalog AND table_name = 'device_config'`,
        { catalog: catalogs.local },
      )
      if (cols.length === 0) return // table absent; baseline will create it
      if (cols.some(c => c.column_name === 'metric')) return

      await db.execute(`DROP TABLE IF EXISTS ${catalogs.local}.device_config_v2;`)
      const tmpDdl = LOCAL_SCHEMAS.device_config.replace(
        'CREATE TABLE device_config',
        `CREATE TABLE ${catalogs.local}.device_config_v2`,
      )
      await db.execute(tmpDdl)
      await db.execute(
        `INSERT INTO ${catalogs.local}.device_config_v2 `
        + `(device_id, brand, family_id, user_id, metric, interval_minutes, `
        + `start_time, end_time, weeks, valid_from, valid_to) `
        + `SELECT device_id, brand, family_id, user_id, `
        + `CASE data_type WHEN 1 THEN 'heart_rate' WHEN 2 THEN 'spo2' `
        + `WHEN 3 THEN 'temperature' WHEN 4 THEN 'hrv' `
        // Unknown codes are preserved rather than dropped, so a firmware
        // revision that added one is diagnosable instead of invisible.
        + `ELSE 'unknown_' || data_type::VARCHAR END, `
        + `interval_minutes, start_time, end_time, weeks, valid_from, valid_to `
        + `FROM ${catalogs.local}.device_config;`,
      )
      await db.execute(`DROP TABLE ${catalogs.local}.device_config;`)
      await db.execute(
        `ALTER TABLE ${catalogs.local}.device_config_v2 RENAME TO device_config;`,
      )
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
