/**
 * Tables an app owns (techspec principle 71).
 *
 * The package owns the ring-sensor and platform tables in `TABLE_NAMES`. A
 * table that only one app's feature needs — ZivaOne's `practice_session` is
 * the first — is declared by that app and handed to `createAnalytics` as
 * `appSchema`, so the package never carries a product's schema and a change
 * to it never needs a package release.
 *
 * The package treats a declared table like its own where it has to:
 *
 *   - created on every attach (`CREATE TABLE IF NOT EXISTS`), locally with
 *     `PARTITIONED BY` stripped, remotely as written unless `localOnly`;
 *   - then the app's own migrations, versioned under their own KV key so app
 *     and package numbering never collide;
 *   - swept by retention (`retention`), push-watermark guarded when
 *     `syncable`, exactly as a package table;
 *   - pushed / fetched on `timeColumn` when the app lists it in
 *     `createSyncManager({ tables })` and passes the same `appSchema` there.
 *
 * Migrations run AFTER the create, so a fresh install already has the
 * current shape: every `up` must be idempotent against it (`ADD COLUMN IF
 * NOT EXISTS`, not `ADD COLUMN`). That is the same contract the package's
 * own migrations keep with the baseline `ensureSchemas`.
 *
 * No `v_*` union view is generated: app tables are read directly, like
 * `insight`.
 */

import type { HybridDuckDB } from './engine'
import type { MigrationCatalogs, MigrationContext } from './migrations'
import type { KVStore } from './types'
import { AnalyticsError } from './errors'
import { REMOTE_NAMESPACE } from './migrations'
import { qualifyDdl, quoteQualifier, TABLE_NAMES, toLocalDdl } from './schemas'

export interface AppTableRetention {
  /** Timestamp column the retention DELETE compares. */
  tsColumn: string
  /** `sensor` follows the effective retention days; `insight` 90 d; `audit` 30 d. */
  kind: 'sensor' | 'insight' | 'audit'
}

export interface AppTable {
  /**
   * `CREATE TABLE <name> (...)`, optionally ending in `PARTITIONED BY (...)`
   * — the same shape as the package's `SCHEMAS`. Declare the row's key as a
   * `PRIMARY KEY` here (principle 66); nothing is injected.
   */
  ddl: string
  /** Watermark column for push / fetch. */
  timeColumn: string
  /** Whether rows go to R2. Gates the retention sweep's push-watermark guard. */
  syncable: boolean
  /** `null` = never swept. A swept table must carry brand, family_id and user_id. */
  retention: AppTableRetention | null
  /** Never created in the attached R2 zone. */
  localOnly?: boolean
}

export interface AppMigration {
  /** Sequential from 1, independent of the package's own migration versions. */
  version: number
  name: string
  /** Idempotent; runs after every declared table has been created. */
  up: (db: HybridDuckDB, catalogs: MigrationCatalogs) => Promise<void>
}

export interface AppSchema {
  /** Scopes the app's migration version in KV. Lowercase identifier, e.g. `zivaone`. */
  namespace: string
  tables: Readonly<Record<string, AppTable>>
  migrations?: readonly AppMigration[]
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/
const NAMESPACE_RE = /^[a-z][a-z0-9_]*$/
const TENANT_COLUMNS = ['brand', 'family_id', 'user_id'] as const

function hasColumn(ddl: string, column: string): boolean {
  // Only ever called with names that passed IDENT_RE, so nothing to escape.
  return IDENT_RE.test(column) && new RegExp(`[(,]\\s*${column}\\s+[A-Z]`, 'i').test(ddl)
}

/**
 * Reject a schema the package could not honour, at `createAnalytics` time
 * rather than on the first attach.
 */
export function validateAppSchema(schema: AppSchema): void {
  const fail = (message: string): never => {
    throw new AnalyticsError('invalid_config', `appSchema: ${message}`)
  }
  if (!NAMESPACE_RE.test(schema.namespace))
    fail(`namespace "${schema.namespace}" must match ${NAMESPACE_RE}`)

  const packageTables = new Set<string>(TABLE_NAMES)
  for (const [name, table] of Object.entries(schema.tables)) {
    if (!IDENT_RE.test(name))
      fail(`table name "${name}" must match ${IDENT_RE}`)
    if (packageTables.has(name))
      fail(`"${name}" is a package table`)
    if (name.startsWith('v_'))
      fail(`"${name}": the v_ prefix is reserved for the package's views`)
    if (!table.ddl.trimStart().startsWith(`CREATE TABLE ${name} (`))
      fail(`"${name}": ddl must start with "CREATE TABLE ${name} ("`)
    if (!hasColumn(table.ddl, table.timeColumn))
      fail(`"${name}": timeColumn "${table.timeColumn}" is not a column`)
    if (table.retention) {
      if (!hasColumn(table.ddl, table.retention.tsColumn))
        fail(`"${name}": retention.tsColumn "${table.retention.tsColumn}" is not a column`)
      // The sweep scopes every DELETE to the attaching tenant.
      const missing = TENANT_COLUMNS.filter(col => !hasColumn(table.ddl, col))
      if (missing.length > 0)
        fail(`"${name}": a swept table needs ${missing.join(', ')}`)
    }
  }

  ;(schema.migrations ?? []).forEach((m, i) => {
    if (m.version !== i + 1)
      fail(`migration "${m.name}" has version ${m.version}, expected ${i + 1}`)
  })
}

export function appSchemaVersionKey(namespace: string, brand: string, tenantId: string): string {
  return `analytics:app_schema_version:${namespace}:${brand}:${tenantId}`
}

/**
 * Create every declared table, then run the app's pending migrations.
 * Called on each attach after the package's own `ensureMigrations`.
 */
export async function ensureAppSchema(
  db: HybridDuckDB,
  kv: KVStore,
  ctx: MigrationContext,
  catalogs: MigrationCatalogs,
  schema: AppSchema,
): Promise<{ from: number, to: number }> {
  for (const [name, table] of Object.entries(schema.tables)) {
    try {
      await db.execute(qualifyDdl(toLocalDdl(table.ddl), name, catalogs.local))
      if (catalogs.remote && !table.localOnly)
        await db.execute(qualifyDdl(table.ddl, name, `${quoteQualifier(catalogs.remote)}.${REMOTE_NAMESPACE}`))
    }
    catch (cause) {
      throw new AnalyticsError('migration_failed', `app table ${name} could not be created`, cause)
    }
  }

  const migrations = schema.migrations ?? []
  const key = appSchemaVersionKey(schema.namespace, ctx.brand, ctx.tenantId)
  const stored = await kv.get<number>(key)
  const from = typeof stored === 'number' ? stored : 0
  for (const migration of migrations) {
    if (migration.version <= from)
      continue
    try {
      await migration.up(db, catalogs)
    }
    catch (cause) {
      throw new AnalyticsError(
        'migration_failed',
        `app migration ${schema.namespace} step-${migration.version} (${migration.name}) failed`,
        cause,
      )
    }
    await kv.set(key, migration.version)
  }
  return { from, to: Math.max(from, migrations.length) }
}
