/**
 * The health pack's migrations — the package's own ledger before packs.
 *
 * Versions 1–8 are the steps every install has applied under
 * `analytics:schema_version:<brand>:<tenantId>`, so this pack keeps that key
 * (`versionKey`) and an existing install replays nothing. Steps 3 and 4 were
 * platform tables (`insight`, `user_baseline`) and now run in the platform
 * pack; their numbers stay so the history lines up.
 */

import type { PackMigration } from '../../core/packs'
import type { HealthTableName } from './tables'
import { addIdentityKey, qualifyDdl, quoteQualifier, toLocalDdl } from '../../core/ddl'
import { listColumns, REMOTE_NAMESPACE } from '../../core/migrations'
import { ensureSchemas } from '../../core/schemas'
import { HEALTH_IDENTITY_COLUMNS, HEALTH_SCHEMAS, HEALTH_TABLE_NAMES } from './tables'

/** Local DDL per health table: `PARTITIONED BY` stripped, identity key added. */
const HEALTH_LOCAL: Readonly<Record<HealthTableName, string>> = Object.freeze(
  Object.fromEntries(
    HEALTH_TABLE_NAMES.map(t => [t, addIdentityKey(toLocalDdl(HEALTH_SCHEMAS[t]), HEALTH_IDENTITY_COLUMNS[t])]),
  ) as Record<HealthTableName, string>,
)

/** The key this ledger has always lived under. */
export function healthVersionKey(brand: string, tenantId: string): string {
  return `analytics:schema_version:${brand}:${tenantId}`
}

/**
 * Legacy KV key format used before T-23 canonicalization (hyphen instead
 * of underscore). Adopted once and deleted.
 */
export function healthLegacyVersionKeys(brand: string, tenantId: string): string[] {
  return [`analytics:schema-version:${brand}:${tenantId}`]
}

export const HEALTH_MIGRATIONS: readonly PackMigration[] = Object.freeze([
  {
    version: 1,
    name: 'baseline schemas',
    async up(db, catalogs) {
      // Always ensure local tables (no PARTITIONED BY; plain DuckDB accepts
      // the DDL). 2-part `<catalog>.<table>` resolves via the local catalog's
      // default `main` schema.
      await ensureSchemas(db, catalogs.local, HEALTH_LOCAL)
      // Ensure remote tables when attached to R2 (with PARTITIONED BY;
      // Iceberg requires it). Since 0.5.0 dropped the `USE <catalog>.default`
      // step, remote DDL must spell the Iceberg namespace explicitly — 2-part
      // `zone_x.<table>` fails with "Schema with name ... not found" on an
      // attached Iceberg catalog.
      if (catalogs.remote) {
        await ensureSchemas(
          db,
          `${quoteQualifier(catalogs.remote)}.${REMOTE_NAMESPACE}`,
          HEALTH_SCHEMAS,
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
      await db.execute(qualifyDdl(HEALTH_LOCAL.device_battery, 'device_battery', catalogs.local))
      if (catalogs.remote) {
        await db.execute(qualifyDdl(HEALTH_SCHEMAS.device_battery, 'device_battery', `${quoteQualifier(catalogs.remote)}.${REMOTE_NAMESPACE}`))
      }
    },
  },
  {
    version: 3,
    // The `insight` v2 rebuild ran here until the platform tables became the
    // platform pack's (package-separation S-02); it is platform migration 2
    // now. The step keeps its number so an install's history still lines up.
    name: 'insight v2 (moved to the platform pack)',
    async up() {},
  },
  {
    version: 4,
    // `user_baseline` is a platform table now (platform migration 1).
    name: 'user_baseline table (moved to the platform pack)',
    async up() {},
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
      const tmpDdl = HEALTH_LOCAL.device_config.replace(
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
    // is applied to the local DDL alone.
    async up(db, catalogs) {
      const local = quoteQualifier(catalogs.local)

      for (const table of Object.keys(HEALTH_IDENTITY_COLUMNS) as HealthTableName[]) {
        const cols = await listColumns(db, catalogs.local, table)
        if (cols.length === 0)
          continue // table absent; migration 1 will create it with the key

        // Column list is spelled out rather than `SELECT *` so a future
        // column reorder cannot silently shift values between columns.
        const columnList = cols.join(', ')

        await db.execute(`DROP TABLE IF EXISTS ${local}.${table}_v2;`)
        await db.execute(
          HEALTH_LOCAL[table].replace(
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
        HEALTH_LOCAL.temperature.replace(
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
  {
    version: 8,
    name: 'sleep_session += settle_min, recovered_min; sleep_stage += source (sleep-correction §3)',
    // The correction pipeline's per-night scalars and per-minute provenance.
    // All three are nullable and appended last, so every existing row copies
    // across unchanged and reads NULL for the new columns.
    //
    // Rebuild, not ALTER, for the same reason as 6 and 7: both tables carry a
    // primary key, and a copy-and-swap is the path this file already trusts.
    // Idempotent: a table that already has the new column is skipped.
    //
    // Local only, per the rule above. A remote catalog created before this has
    // the old shapes; the `v_*` union reads `SELECT *` on both sides, so cloud
    // sync needs the remote tables evolved server-side before it is switched
    // on (sleep-correction §3 note). Cloud sync is off today.
    async up(db, catalogs) {
      const local = quoteQualifier(catalogs.local)
      const additions: Array<[HealthTableName, string]> = [
        ['sleep_session', 'settle_min'],
        ['sleep_stage', 'source'],
      ]
      for (const [table, marker] of additions) {
        const cols = await listColumns(db, catalogs.local, table)
        if (cols.length === 0 || cols.includes(marker))
          continue // absent (migration 1 creates it new) or already migrated

        const columnList = cols.join(', ')
        await db.execute(`DROP TABLE IF EXISTS ${local}.${table}_v2;`)
        await db.execute(
          HEALTH_LOCAL[table].replace(`CREATE TABLE ${table}`, `CREATE TABLE ${local}.${table}_v2`),
        )
        await db.execute(
          `INSERT INTO ${local}.${table}_v2 (${columnList}) `
          + `SELECT ${columnList} FROM ${local}.${table} ON CONFLICT DO NOTHING;`,
        )
        await db.execute(`DROP TABLE ${local}.${table};`)
        await db.execute(`ALTER TABLE ${local}.${table}_v2 RENAME TO ${table};`)
      }
    },
  },
])

/** Version of the health ledger's latest migration. */
export const HEALTH_CURRENT_VERSION: number = HEALTH_MIGRATIONS.length
