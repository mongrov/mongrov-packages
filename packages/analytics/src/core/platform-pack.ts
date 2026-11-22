/**
 * The platform pack: tables every app gets, whatever its domain.
 *
 * Its migrations run under their own key
 * (`analytics:pack_schema_version:platform:<brand>:<tenantId>`). On an
 * install that predates packs the first two migrations are no-ops — the tables
 * exist and `insight` already has its v2 shape — so they only cost two
 * `IF NOT EXISTS` statements and a column probe, once. Step 3 (0.62.0) adds
 * the structured-result columns to `tool_call_audit`.
 */

import type { AnalyticsPack, PackMigration } from './packs'
import type { PlatformTableName } from './platform-tables'
import { platformTools } from '../tools/platform-tools'
import { addIdentityKey, qualifyDdl, quoteQualifier, toLocalDdl } from './ddl'
import { listColumns, REMOTE_NAMESPACE } from './migrations'
import { PLATFORM_SCHEMAS, PLATFORM_TABLE_NAMES, PLATFORM_TABLES } from './platform-tables'
import { ensureSchemas } from './schemas'

/**
 * Lookup index for the `insight` table (spec §Table schema). Local catalog
 * only — Iceberg has no CREATE INDEX; remote-side query pruning comes from
 * the `day(ts)` partition instead.
 */
export function insightIndexDdl(catalog: string): string {
  return `CREATE INDEX IF NOT EXISTS idx_insight_lookup ON ${quoteQualifier(catalog)}.insight (user_id, metric, dismissed_at, ts);`
}

/**
 * The `tool_call_audit` columns platform migration 3 adds (0.62.0), in DDL
 * order. All nullable: rows written before it keep NULL in each.
 */
export const TOOL_CALL_AUDIT_V3_COLUMNS: readonly (readonly [column: string, type: string])[] = Object.freeze([
  ['result_status', 'VARCHAR'],
  ['error_code', 'VARCHAR'],
  ['result_digest', 'VARCHAR'],
  ['render_chars', 'INTEGER'],
  ['truncated_items', 'INTEGER'],
  ['turn_id', 'VARCHAR'],
  ['call_index', 'INTEGER'],
  ['cached', 'BOOLEAN'],
] as const)

function localDdl(table: PlatformTableName): string {
  return addIdentityKey(toLocalDdl(PLATFORM_SCHEMAS[table]), PLATFORM_TABLES[table].identity)
}

const PLATFORM_MIGRATIONS: readonly PackMigration[] = Object.freeze([
  {
    version: 1,
    name: 'platform tables',
    async up(db, catalogs) {
      await ensureSchemas(
        db,
        catalogs.local,
        Object.fromEntries(PLATFORM_TABLE_NAMES.map(t => [t, localDdl(t)])),
      )
      if (catalogs.remote) {
        await ensureSchemas(
          db,
          `${quoteQualifier(catalogs.remote)}.${REMOTE_NAMESPACE}`,
          PLATFORM_SCHEMAS,
          { skipLocalOnly: true },
        )
      }
    },
  },
  {
    version: 2,
    name: 'insight v2 (insight_id / metric / kind / dismissed_at)',
    // Fix CO-2: the pre-0.7.0 `insight` table used an `id` PK and lacked
    // the spec's `metric`, `kind`, and `dismissed_at` columns, so the
    // registry contract (queries.ts worthALookInsight) could never match.
    // Recreates the LOCAL table to the spec shape, preserving rows:
    //   id → insight_id, kind defaults to 'threshold', severity
    //   'critical' → 'urgent' (spec enum is info|warn|urgent).
    // Idempotent: skips the recreate when `metric` is already present
    // (fresh installs get the new shape from step 1).
    // The remote zone gets CREATE IF NOT EXISTS only — the client never
    // destructively rewrites the attached Iceberg catalog; schema
    // evolution of pre-existing remote tables is a server-side operation.
    // Package ledger step 3 before packs.
    async up(db, catalogs) {
      const cols = await listColumns(db, catalogs.local, 'insight')
      const hasMetric = cols.includes('metric')
      if (!hasMetric) {
        // Re-entrancy: a prior partially-failed run may have left the
        // scratch table behind (KV only advances after full success).
        await db.execute(`DROP TABLE IF EXISTS ${quoteQualifier(catalogs.local)}.insight_v2;`)
        const tmpDdl = localDdl('insight').replace(
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
        await db.execute(qualifyDdl(PLATFORM_SCHEMAS.insight, 'insight', `${quoteQualifier(catalogs.remote)}.${REMOTE_NAMESPACE}`))
      }
    },
  },
  {
    version: 3,
    name: 'tool_call_audit v3 (result_status / error_code / result_digest / render_chars / truncated_items / turn_id / call_index / cached)',
    // The structured-result audit (analytics 0.62.0). `ADD COLUMN` of
    // nullable columns, so existing rows stay valid and nothing is copied;
    // the table has no key, so no constraint can fire (principle 66).
    //
    // Idempotent: each column is added only when the probe does not list it,
    // so a re-run (KV advances only after full success) adds nothing, and a
    // fresh install, whose step 1 already created the new shape, issues
    // only the probe. A table the probe cannot see is left to step 1.
    //
    // Derived tables keyed to the table's shape (mongrov-packages#109): the
    // flusher's `<table>__stg` / `<table>__probe` mirrors are created once
    // from the table and written by position, so a mirror built before this
    // ALTER would be one-shape-old forever. `tool_call_audit` is written by
    // the audit writer's INSERT, never by the flusher, so none should exist;
    // any that does is empty between flushes by construction, so it is
    // dropped whenever a column was added and is rebuilt from the new shape
    // on first use.
    //
    // Remote: the table is never pushed (`syncable: false`), so an existing
    // remote copy is left as it is (the client never rewrites the attached
    // catalog's tables); a fresh remote gets the new shape from step 1.
    async up(db, catalogs) {
      const local = quoteQualifier(catalogs.local)
      const cols = await listColumns(db, catalogs.local, 'tool_call_audit')
      if (cols.length === 0)
        return
      const missing = TOOL_CALL_AUDIT_V3_COLUMNS.filter(([c]) => !cols.includes(c))
      for (const [column, type] of missing)
        await db.execute(`ALTER TABLE ${local}.tool_call_audit ADD COLUMN ${column} ${type};`)
      if (missing.length > 0) {
        await db.execute(`DROP TABLE IF EXISTS ${local}.tool_call_audit__stg;`)
        await db.execute(`DROP TABLE IF EXISTS ${local}.tool_call_audit__probe;`)
      }
    },
  },
])

/** Always registered, after every other pack. */
export const PLATFORM_PACK: AnalyticsPack = {
  name: 'platform',
  tables: PLATFORM_TABLES,
  migrations: PLATFORM_MIGRATIONS,
  tools: platformTools,
  // Before packs, these steps ran under the package ledger: its step 1
  // created every table, step 3 rebuilt `insight`, step 4 created
  // `user_baseline`. An install at 4 or later has both platform steps'
  // effects, so it starts at 2 and issues no DDL. Anything earlier replays
  // both (each is idempotent) rather than guess which tables exist. The
  // adopted version — 0 included — is persisted before any pack runs
  // (`ensureMigrations`), so an attach interrupted before these steps
  // commit retries them instead of re-adopting from a ledger another pack
  // has since advanced.
  adoptVersion: {
    keys: (brand, tenantId) => [
      `analytics:schema_version:${brand}:${tenantId}`,
      `analytics:schema-version:${brand}:${tenantId}`,
    ],
    map: v => (v >= 4 ? 2 : 0),
  },
}
