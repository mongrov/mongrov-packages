/**
 * Schema migrations for the warehouse.
 *
 * Every pack (`core/packs.ts`) carries its own ordered migrations and its own
 * applied-version ledger in KV, per `(brand, tenantId)`. `ensureMigrations`
 * runs each pack's pending steps on every attach — registered packs in
 * order, then the platform pack — with the catalog set for the current
 * attach mode:
 *
 * - `local` — the local DuckDB catalog name (always present, from
 *   `current_database()`). Local DDL runs here.
 * - `remote` — the attached R2 iceberg catalog secret name (present only
 *   in R2 mode). Remote DDL (with `PARTITIONED BY`) runs here.
 *
 * A pack creates its own tables in its first migration (`ensureSchemas`),
 * so an install that is up to date issues no DDL at all.
 *
 * `ensureMigrations` is idempotent and safe to call on every attach.
 */

import type { HybridDuckDB } from './engine'
import type { AnalyticsPack, PackMigration } from './packs'
import type { KVStore } from './types'
import { quoteQualifier } from './ddl'
import { AnalyticsError } from './errors'
import { getPacks } from './packs'

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

/** One migration step. */
export type Migration = PackMigration

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
export async function listColumns(
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
    // expected: either the table does not exist, or this build has no
    // table_info. Fall back to information_schema for platforms where it works.
    try {
      const rows = await db.execute<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns `
        + `WHERE table_catalog = $catalog AND table_name = $table`,
        { catalog, table },
      )
      return rows.map((r: { column_name: string }) => r.column_name)
    }
    catch {
      // expected: no table to list. An empty list is how callers spell
      // "table absent"; a real engine fault resurfaces on the DDL that follows.
      return []
    }
  }
}

/**
 * KV key holding the package ledger's applied version for a
 * `(brand, tenantId)` pair — the ledger every install kept before packs,
 * inherited by the pack that declares it as its `versionKey`.
 */
export function schemaVersionKey(brand: string, tenantId: string): string {
  return `analytics:schema_version:${brand}:${tenantId}`
}

/** Default KV key for a pack's applied migration version. */
export function packVersionKey(pack: string, brand: string, tenantId: string): string {
  return `analytics:pack_schema_version:${pack}:${brand}:${tenantId}`
}

export interface PackMigrationResult {
  from: number
  to: number
  /** The KV key the version is stored under. */
  key: string
}

export interface EnsureMigrationsResult {
  /**
   * The package ledger (`schemaVersionKey`) when a pack keeps it, else the
   * platform pack's — what `from`/`to` meant before packs.
   */
  from: number
  to: number
}

/**
 * Run one pack's migrations between its persisted version and its latest.
 *
 * - First launch: `from = 0`, applies every migration.
 * - Same-version rerun: no-op, KV unchanged, returns `from === to`.
 * - Upgrade path: applies only newer migrations in order.
 * - Any failure at step N surfaces as
 *   `AnalyticsError('migration_failed', 'step-<n>', cause)`. KV is only
 *   advanced after each successful step so a partial upgrade leaves the
 *   version at the last successful step (subsequent runs retry from there).
 */
export async function runPackMigrations(
  db: HybridDuckDB,
  kv: KVStore,
  ctx: MigrationContext,
  catalogs: MigrationCatalogs,
  pack: AnalyticsPack,
): Promise<PackMigrationResult> {
  const migrations = pack.migrations ?? []
  const key = versionKeyOf(pack, ctx)
  let stored = await kv.get<number>(key)

  // One-shot adoption of an older key spelling: if the canonical key is
  // absent but a legacy value exists, adopt it under the new key and remove
  // the legacy entry so this branch stays cold on next boot.
  if (stored === undefined) {
    for (const legacyKey of pack.legacyVersionKeys?.(ctx.brand, ctx.tenantId) ?? []) {
      const legacyValue = await kv.get<number>(legacyKey)
      if (typeof legacyValue === 'number') {
        await kv.set(key, legacyValue)
        await kv.delete(legacyKey)
        stored = legacyValue
        break
      }
    }
  }

  const from = typeof stored === 'number' ? stored : 0
  const latest = migrations.length
  if (from >= latest)
    return { from, to: from, key }

  for (const migration of migrations) {
    if (migration.version <= from)
      continue
    try {
      await migration.up(db, catalogs)
    }
    catch (cause) {
      throw new AnalyticsError(
        'migration_failed',
        `migration step-${migration.version} (${migration.name}) failed in pack ${pack.name}`,
        cause,
      )
    }
    await kv.set(key, migration.version)
  }
  return { from, to: latest, key }
}

/**
 * Run every registered pack's pending migrations, registered packs in
 * order, then the platform pack. Stops at the first failure.
 */
export async function ensureMigrations(
  db: HybridDuckDB,
  kv: KVStore,
  ctx: MigrationContext,
  catalogs: MigrationCatalogs,
  packs: readonly AnalyticsPack[] = getPacks(),
  onPack?: (pack: string, result: PackMigrationResult) => void,
): Promise<EnsureMigrationsResult> {
  const withMigrations = packs.filter(p => p.migrations?.length)
  // Adoption reads the other ledgers as they were before this attach, so a
  // pack that runs first cannot make a fresh install look migrated.
  const seeds = new Map<AnalyticsPack, number>()
  for (const pack of withMigrations) {
    if (!pack.adoptVersion)
      continue
    if (typeof await kv.get<number>(versionKeyOf(pack, ctx)) === 'number')
      continue
    for (const key of pack.adoptVersion.keys(ctx.brand, ctx.tenantId)) {
      const v = await kv.get<number>(key)
      if (typeof v === 'number') {
        seeds.set(pack, pack.adoptVersion.map(v))
        break
      }
    }
  }
  for (const [pack, seed] of seeds) {
    if (seed > 0)
      await kv.set(versionKeyOf(pack, ctx), seed)
  }

  const ledger = schemaVersionKey(ctx.brand, ctx.tenantId)
  let primary: PackMigrationResult | undefined
  let platform: PackMigrationResult | undefined
  for (const pack of withMigrations) {
    const result = await runPackMigrations(db, kv, ctx, catalogs, pack)
    onPack?.(pack.name, result)
    if (result.key === ledger)
      primary = result
    if (pack.name === 'platform')
      platform = result
  }
  const r = primary ?? platform
  return { from: r?.from ?? 0, to: r?.to ?? 0 }
}

function versionKeyOf(pack: AnalyticsPack, ctx: MigrationContext): string {
  return pack.versionKey?.(ctx.brand, ctx.tenantId) ?? packVersionKey(pack.name, ctx.brand, ctx.tenantId)
}
