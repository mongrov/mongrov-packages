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
 *      per retention-managed table, guarded by the per-table push watermark
 *      from `sync_watermark` so rows still awaiting server sync are never
 *      dropped (spec Fix 9).
 *
 * Internal tables have fixed defaults independent of brand/user config:
 *   - `insight`          → 90 days
 *   - `tool_call_audit`  → 30 days
 *
 * Tables without a retention semantic (`device_config`, `sync_watermark`)
 * are skipped.
 */

import { AnalyticsError } from './errors'
import type { HybridDuckDB } from './engine'
import type { TableName } from './schemas'

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
 * `tsColumn` names the timestamp column the DELETE uses; `watermarkKind`
 * is the `kind` filter for the `sync_watermark` lookup (spec uses
 * per-metric `kind` per table).
 */
interface TableRetention {
  tsColumn: string
  kind: 'sensor' | 'insight' | 'audit'
  /** Filter used against `sync_watermark.kind`; defaults to the table name. */
  watermarkKind?: string
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
})

// -------------------- constants --------------------

/** Fixed retention for the `insight` table — spec §Retention. */
export const INSIGHT_RETENTION_DAYS = 90
/** Fixed retention for the `tool_call_audit` table — spec §Retention. */
export const AUDIT_RETENTION_DAYS = 30

// -------------------- sweep --------------------

export interface RetentionSweepInput {
  /** Effective retention days for sensor tables (see `resolveEffectiveRetention`). */
  effectiveDays: number
}

export interface RetentionSweepEntry {
  table: TableName
  days: number
}

export interface RetentionSweepResult {
  swept: RetentionSweepEntry[]
}

/**
 * Delete expired rows across every retention-managed table under `catalog`,
 * bounded by each table's push watermark (`sync_watermark.cursor_ts`).
 *
 * SQL shape per table:
 *
 * ```sql
 * DELETE FROM {catalog}.{table}
 *  WHERE {tsCol} < LEAST(
 *    now() - INTERVAL '{days} days',
 *    (SELECT MAX(cursor_ts) FROM {catalog}.sync_watermark
 *      WHERE table_name = '{table}')
 *  );
 * ```
 *
 * When no watermark exists, `MAX` returns NULL, `LEAST` becomes NULL and the
 * comparison drops to false — safest default (no deletion on unsynced data).
 *
 * Failure at any table surfaces as `AnalyticsError('retention_failed', …)`;
 * the caller decides whether to swallow-and-log or bubble.
 */
export async function runRetentionSweep(
  db: HybridDuckDB,
  catalog: string,
  input: RetentionSweepInput,
): Promise<RetentionSweepResult> {
  const swept: RetentionSweepEntry[] = []
  const tableNames = Object.keys(TABLE_RETENTION) as TableName[]
  for (const table of tableNames) {
    const cfg = TABLE_RETENTION[table]
    if (!cfg) continue

    const days = daysForKind(cfg.kind, input.effectiveDays)
    const sql = buildDeleteSql({ catalog, table, tsCol: cfg.tsColumn, days })
    try {
      await db.execute(sql)
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
  return { swept }
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

interface DeleteSqlInput {
  catalog: string
  table: TableName
  tsCol: string
  days: number
}

/**
 * Compose the retention DELETE for one table. Extracted so tests can snapshot
 * the exact SQL issued without a live engine.
 */
export function buildDeleteSql(input: DeleteSqlInput): string {
  const { catalog, table, tsCol, days } = input
  return (
    `DELETE FROM ${catalog}.${table} `
    + `WHERE ${tsCol} < LEAST(`
    + `now() - INTERVAL '${days} days', `
    + `(SELECT MAX(cursor_ts) FROM ${catalog}.sync_watermark WHERE table_name = '${table}')`
    + `);`
  )
}
