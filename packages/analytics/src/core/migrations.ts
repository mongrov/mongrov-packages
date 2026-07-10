/**
 * Schema migrations for the warehouse.
 *
 * Version is tracked per `(brand, tenantId)` in KVStore. v0.1.0 has a single
 * baseline migration (step 1: `ensureSchemas`) — future migrations append to
 * `MIGRATIONS` in order; each `up(db)` receives the attached catalog name.
 *
 * `ensureMigrations` is idempotent and safe to call on every attach.
 */

import { AnalyticsError } from './errors'
import type { HybridDuckDB } from './engine'
import { ensureSchemas } from './schemas'
import type { KVStore } from './types'

export interface MigrationContext {
  brand: string
  tenantId: string
}

export interface Migration {
  /** Sequential integer, starting at 1. */
  version: number
  /** Human name shown in errors + logs. */
  name: string
  /** Idempotent DDL — called with the attached catalog alias. */
  up(db: HybridDuckDB, catalog: string): Promise<void>
}

/**
 * Ordered list of migrations. Each entry's `version` must equal its
 * (1-based) position; `CURRENT_VERSION` is derived from the tail.
 */
export const MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: 'baseline schemas',
    async up(db, catalog) {
      await ensureSchemas(db, catalog)
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
  catalog: string,
): Promise<EnsureMigrationsResult> {
  const key = schemaVersionKey(ctx.brand, ctx.tenantId)
  const stored = await kv.get<number>(key)
  const from = typeof stored === 'number' ? stored : 0

  if (from >= CURRENT_VERSION) {
    return { from, to: from }
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) {
      continue
    }
    try {
      await migration.up(db, catalog)
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
