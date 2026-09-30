/**
 * Retention scheduler for the analytics warehouse.
 *
 * Two responsibilities:
 *
 *   1. **Resolve** effective retention days for `(brand, tenantId, userId)`
 *      via `resolveEffectiveRetention` — precedence per spec §Retention
 *      is `max(userOverride, familySetting, brandDefault)` so *any* layer
 *      that would preserve data wins.
 *
 *   2. **Sweep** the warehouse via `runRetentionSweep` — issues one DELETE
 *      per retention-managed table in the LOCAL catalog. The client never
 *      sweeps the remote R2 zone (principles 17/53): device-side compaction
 *      prunes local data only; server-side retention is R2 snapshot
 *      expiration, configured externally.
 *
 * Watermark guard (fix CO-1): tables the pusher pushes (`syncable` in
 * `table_metadata.ts`) are bounded by their KVStore push watermark —
 * `ts < LEAST(now() - retention, $pushWatermark)` — so rows still awaiting
 * R2 push are never dropped. No watermark yet (nothing pushed) means the
 * table is skipped entirely. In `'local'` mode there is no push and never
 * will be — data is local-forever by design — so the plain retention
 * cutoff applies without any watermark guard.
 *
 * Internal tables have fixed defaults independent of brand/user config:
 *   - `insight`          → 90 days
 *   - `tool_call_audit`  → 30 days
 *
 * Tables without a retention semantic (`device_config`, `sync_watermark`)
 * are skipped.
 */

import type { HybridDuckDB } from './engine'
import type { TableName } from './schemas'
import type { AnalyticsMode } from './types'
import { AnalyticsError } from './errors'
import { quoteQualifier } from './schemas'
import { isSyncable } from './table_metadata'

// -------------------- precedence resolution --------------------

export interface EffectiveRetentionInput {
  /** Brand-level default (v0.1.0 active layer) — from `AnalyticsConfig.retention[brand].days`. */
  brandDefault: number
  /** Family-level setting (v2 candidate — plumbed but unused by v0.1.0). */
  familySetting?: number
  /** User override (v2 candidate — plumbed via `setRetention`, unused in v0.1.0 UX). */
  userOverride?: number
}

/**
 * Resolve effective retention days per spec §Retention precedence — returns
 * `max(userOverride ?? 0, familySetting ?? 0, brandDefault)`.
 *
 * Rationale: retention is *protective* — if any layer would preserve data
 * longer, we honour that layer (max wins, not first-match).
 */
export function resolveEffectiveRetention(input: EffectiveRetentionInput): number {
  return Math.max(
    input.userOverride ?? 0,
    input.familySetting ?? 0,
    input.brandDefault,
  )
}

// -------------------- per-table config --------------------

/**
 * Retention behaviour per warehouse table. `null` means "no retention sweep"
 * (config / watermark tables). `kind` selects the retention days source:
 *
 *   - `sensor`  → uses `effectiveDays` from `resolveEffectiveRetention`
 *   - `insight` → uses fixed 90d
 *   - `audit`   → uses fixed 30d
 *
 * `tsColumn` names the timestamp column the DELETE uses. Whether a table
 * gets the push-watermark guard comes from `table_metadata.ts` `syncable`
 * — the guard covers exactly the tables the pusher pushes.
 */
interface TableRetention {
  tsColumn: string
  kind: 'sensor' | 'insight' | 'audit'
}

const TABLE_RETENTION: Readonly<Record<TableName, TableRetention | null>> = Object.freeze({
  hrv: { tsColumn: 'ts', kind: 'sensor' },
  heart_rate: { tsColumn: 'ts', kind: 'sensor' },
  spo2: { tsColumn: 'ts', kind: 'sensor' },
  temperature: { tsColumn: 'ts', kind: 'sensor' },
  activity: { tsColumn: 'ts', kind: 'sensor' },
  activity_bucket: { tsColumn: 'ts', kind: 'sensor' },
  // `sleep_session` retains by session close, not start — a session that ends
  // outside the retention window has fully aged out.
  sleep_session: { tsColumn: 'ts_end', kind: 'sensor' },
  sleep_stage: { tsColumn: 'ts', kind: 'sensor' },
  sleep_raw: { tsColumn: 'ts', kind: 'sensor' },
  device_event: { tsColumn: 'ts', kind: 'sensor' },
  device_battery: { tsColumn: 'ts', kind: 'sensor' },
  device_config: null,
  insight: { tsColumn: 'ts', kind: 'insight' },
  sync_watermark: null,
  tool_call_audit: { tsColumn: 'ts', kind: 'audit' },
  // Never swept: one row per (user, metric, window) that the baseline
  // job UPSERTs in place. There is no growth to reclaim, and deleting
  // by `computed_at` would drop live baselines for any metric whose
  // recompute is stale.
  user_baseline: null,
})

// -------------------- constants --------------------

/** Fixed retention for the `insight` table — spec §Retention. */
export const INSIGHT_RETENTION_DAYS = 90
/** Fixed retention for the `tool_call_audit` table — spec §Retention. */
export const AUDIT_RETENTION_DAYS = 30

// -------------------- sweep --------------------

/**
 * Push-watermark accessor injected by the factory. Resolves the highest
 * `ts` successfully pushed to R2 for `table` — read from the KVStore key
 * the pusher writes (`analytics:watermark:{brand}:{familyId}:{table}:push`,
 * see sync/watermark.ts). `null` means nothing pushed yet.
 */
export type PushWatermarkAccessor = (table: TableName) => Promise<Date | null>

export interface RetentionSweepInput {
  /** Effective retention days for sensor tables (see `resolveEffectiveRetention`). */
  effectiveDays: number
  /**
   * Attach mode. `'local'` applies plain retention cutoffs — there is no
   * push in local mode, so nothing ever "reaches R2" and the watermark
   * guard would block deletion forever. Defaults to `'r2'`.
   */
  mode?: AnalyticsMode
  /**
   * Required in r2 mode to sweep syncable tables. Missing accessor or a
   * `null` watermark ⇒ the table is skipped (spec: no data deleted before
   * it reaches R2).
   */
  getPushWatermark?: PushWatermarkAccessor
  /**
   * The attach context's tenant. Required, and bound into every DELETE.
   *
   * Without it the sweep deleted by timestamp alone: one family's successful
   * push watermark removed ANOTHER family's unsynced historical readings,
   * because the generated DELETE carried no `brand`, `family_id` or user
   * predicate. Reproduced against real DuckDB in the 2026-09-26 review
   * (finding 2). The spec was complicit — techspec T-14's acceptance criterion
   * specified exactly that unscoped DELETE, so the code passed its own AC.
   */
  tenant: RetentionTenant
}

export interface RetentionSweepEntry {
  table: TableName
  days: number
}

export interface RetentionSweepResult {
  swept: RetentionSweepEntry[]
  /** Syncable tables left untouched because no push watermark exists yet. */
  skipped: TableName[]
}

/**
 * Delete expired rows across every retention-managed table under `catalog`
 * (the LOCAL DuckDB catalog — never the attached R2 zone).
 *
 * SQL shape per table:
 *
 * ```sql
 * -- pushed (syncable) tables, r2 mode:
 * DELETE FROM {catalog}.{table}
 *  WHERE {tsCol} < LEAST(now() - INTERVAL '{days} days',
 *                        CAST($pushWatermark AS TIMESTAMP))
 *    AND brand = $brand AND family_id = $familyId AND user_id = $userId;
 * -- non-pushed tables, and every table in local mode:
 * DELETE FROM {catalog}.{table}
 *  WHERE {tsCol} < now() - INTERVAL '{days} days'
 *    AND brand = $brand AND family_id = $familyId AND user_id = $userId;
 * ```
 *
 * The tenant predicate is not optional. `tool_call_audit` is scoped by brand
 * and family only — it has no `user_id`.
 *
 * Failure at any table surfaces as `AnalyticsError('retention_failed', …)`;
 * the caller decides whether to swallow-and-log or bubble.
 */
export async function runRetentionSweep(
  db: HybridDuckDB,
  catalog: string,
  input: RetentionSweepInput,
): Promise<RetentionSweepResult> {
  const mode = input.mode ?? 'r2'
  const swept: RetentionSweepEntry[] = []
  const skipped: TableName[] = []
  const tableNames = Object.keys(TABLE_RETENTION) as TableName[]
  for (const table of tableNames) {
    const cfg = TABLE_RETENTION[table]
    if (!cfg)
      continue

    const days = daysForKind(cfg.kind, input.effectiveDays)
    const guarded = mode !== 'local' && isSyncable(table)
    const tenantColumns = tenantColumnsFor(table)
    // Bound on EVERY sweep, guarded or not: the scope is not an optimisation,
    // it is what keeps the delete inside this tenant.
    let params: Record<string, unknown> = tenantParamsFor(tenantColumns, input.tenant)
    if (guarded) {
      const watermark = (await input.getPushWatermark?.(table)) ?? null
      if (!watermark) {
        // Nothing pushed yet — deleting would lose data that never
        // reached R2. Leave the table alone until the pusher advances.
        skipped.push(table)
        continue
      }
      params = { ...params, pushWatermark: watermark.toISOString() }
    }

    const sql = buildDeleteSql({ catalog, table, tsCol: cfg.tsColumn, days, watermarkBound: guarded, tenantColumns })
    try {
      await db.execute(sql, params)
      swept.push({ table, days })
    }
    catch (cause) {
      throw new AnalyticsError(
        'retention_failed',
        `runRetentionSweep failed on table ${table}`,
        cause,
      )
    }
  }
  return { swept, skipped }
}

function daysForKind(kind: TableRetention['kind'], effective: number): number {
  switch (kind) {
    case 'sensor':
      return effective
    case 'insight':
      return INSIGHT_RETENTION_DAYS
    case 'audit':
      return AUDIT_RETENTION_DAYS
  }
}

/** The attach context's tenant, bound into every retention DELETE. */
export interface RetentionTenant {
  brand: string
  /** `AttachContext.tenantId` — the `family_id` column. */
  familyId: string
  userId: string
}

const TENANT_PARAM_FOR: Readonly<Record<string, string>> = Object.freeze({
  brand: 'brand',
  family_id: 'familyId',
  user_id: 'userId',
})

/**
 * The tenant columns present on a swept table.
 *
 * Every swept table carries `brand` and `family_id`. `tool_call_audit` is the
 * one without `user_id` — it records calls at family scope, under
 * `requester_user_id` — so scoping it by `user_id` would not compile into
 * valid SQL at all.
 */
function tenantColumnsFor(table: TableName): readonly string[] {
  return table === 'tool_call_audit'
    ? ['brand', 'family_id']
    : ['brand', 'family_id', 'user_id']
}

/**
 * Params for exactly the scope columns a table has — no more.
 *
 * DuckDB rejects a named parameter the statement never references, so binding
 * `$userId` for `tool_call_audit` fails the sweep on that table. The params
 * therefore follow `tenantColumnsFor`, not a fixed shape.
 */
function tenantParamsFor(columns: readonly string[], tenant: RetentionTenant): Record<string, unknown> {
  const value: Readonly<Record<string, string>> = {
    brand: tenant.brand,
    family_id: tenant.familyId,
    user_id: tenant.userId,
  }
  return Object.fromEntries(columns.map(col => [TENANT_PARAM_FOR[col], value[col]]))
}

interface DeleteSqlInput {
  catalog: string
  table: TableName
  tsCol: string
  days: number
  /** Bound by `$pushWatermark` (ISO string param, cast to TIMESTAMP). */
  watermarkBound?: boolean
  /**
   * Tenant columns to scope the delete by, from `tenantColumnsFor`. Required:
   * an unscoped retention DELETE deletes other tenants' rows using THIS
   * tenant's watermark, and the app shares one persistent `memory.duckdb`
   * across accounts, so their rows genuinely coexist.
   */
  tenantColumns: readonly string[]
}

/**
 * Compose the retention DELETE for one table. Extracted so tests can snapshot
 * the exact SQL issued without a live engine.
 */
export function buildDeleteSql(input: DeleteSqlInput): string {
  const { catalog, table, tsCol, days, watermarkBound, tenantColumns } = input
  const cutoff = `now() - INTERVAL '${days} days'`
  const bound = watermarkBound
    ? `LEAST(${cutoff}, CAST($pushWatermark AS TIMESTAMP))`
    : cutoff
  const scope = tenantColumns
    .map(col => ` AND ${col} = $${TENANT_PARAM_FOR[col]}`)
    .join('')
  return `DELETE FROM ${quoteQualifier(catalog)}.${table} WHERE ${tsCol} < ${bound}${scope};`
}
