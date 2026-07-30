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
import { ensureSchemas, LOCAL_SCHEMAS, qualifyDdl, SCHEMAS } from './schemas'
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
        await ensureSchemas(db, `${catalogs.remote}.${REMOTE_NAMESPACE}`, SCHEMAS)
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
