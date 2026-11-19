/**
 * Table DDL plumbing for the warehouse.
 *
 * Tables are declared by packs (`core/packs.ts`): the platform's own, the
 * domain packs', and the app's `appSchema`. This module turns a declaration
 * into the statements the engine issues:
 *
 * - remote (Iceberg) DDL is the declaration as written, with its
 *   `PARTITIONED BY (...)` clause, which Iceberg needs for partition pruning;
 * - local DDL strips `PARTITIONED BY` (plain DuckDB rejects it) and adds the
 *   table's identity tuple as a `PRIMARY KEY` (principle 66);
 * - `v_{table}` union views read local rows past the push watermark plus the
 *   remote copy (principle 19).
 *
 * `ensureSchemas(db, catalog, schemas)` idempotently creates every given
 * table inside a catalog, rewriting `CREATE TABLE <name>` to
 * `CREATE TABLE IF NOT EXISTS <catalog>.<name>` at issue time.
 */

import type { AppSchema } from './app-schema'
import type { HybridDuckDB } from './engine'
import { addIdentityKey, qualifyDdl, quoteQualifier, toLocalDdl } from './ddl'
import { AnalyticsError } from './errors'
import { packTable, packTables } from './packs'

export { addIdentityKey, qualifyDdl, quoteQualifier, toLocalDdl } from './ddl'
export { insightIndexDdl } from './platform-pack'

/**
 * Local DDL for a registered table (or one the app declared): `PARTITIONED
 * BY` stripped, identity key added. `undefined` for an unknown table.
 */
export function localDdlFor(table: string, appSchema?: AppSchema): string | undefined {
  const t = packTable(table)
  if (t)
    return addIdentityKey(toLocalDdl(t.ddl), t.identity)
  const app = appSchema?.tables[table]
  return app ? toLocalDdl(app.ddl) : undefined
}

/** Whether a table's local DDL carries a `PRIMARY KEY`. */
export function hasLocalPrimaryKey(table: string, appSchema?: AppSchema): boolean {
  return localDdlFor(table, appSchema)?.includes('PRIMARY KEY') ?? false
}

/** Timestamp column the watermark partitions on, per viewed table. */
export function watermarkColumnFor(table: string): string {
  return packTable(table)?.timeColumn ?? 'ts'
}

/**
 * Build the `CREATE OR REPLACE VIEW v_{table}` DDL for one viewed table.
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
  table: string,
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

function sqlLiteral(value: string): string {
  return `'${value.replace(SINGLE_QUOTE_RE, `''`)}'`
}

/** `DROP VIEW IF EXISTS v_{table}` for detach + brand switch. */
export function dropViewDdl(table: string): string {
  return `DROP VIEW IF EXISTS v_${table};`
}

/**
 * Inject a registered table's identity tuple as a `PRIMARY KEY` on its
 * local DDL. A no-op for tables without one, and for DDL that already
 * declares a key.
 */
export function withIdentityKey(table: string, localDdl: string): string {
  return addIdentityKey(localDdl, packTable(table)?.identity)
}

/**
 * Remote DDL for every registered pack table, in pack order. The default
 * `schemas` for `ensureSchemas`.
 */
export function registeredSchemas(): Readonly<Record<string, string>> {
  return Object.fromEntries(Array.from(packTables(), ([name, t]) => [name, t.ddl]))
}

/**
 * Create the given tables under `<catalog>.<table>`, in key order.
 *
 * Idempotent — every issued statement uses `IF NOT EXISTS`. Failure at any
 * table surfaces as `AnalyticsError('migration_failed', <table>, cause)`.
 *
 * `schemas` selects the tables and the DDL variant: remote DDL (with
 * `PARTITIONED BY`) for remote Iceberg catalogs, local DDL for the local
 * DuckDB catalog. Default: the remote DDL of every registered table.
 */
export async function ensureSchemas(
  db: HybridDuckDB,
  catalog: string,
  schemas: Readonly<Record<string, string>> = registeredSchemas(),
  opts: { skipLocalOnly?: boolean } = {},
): Promise<void> {
  for (const table of Object.keys(schemas)) {
    // Remote passes `skipLocalOnly` so derived/bookkeeping tables never get
    // created in the user's R2 zone.
    if (opts.skipLocalOnly && packTable(table)?.localOnly) {
      continue
    }
    const sql = qualifyDdl(schemas[table]!, table, catalog)
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
