/**
 * Tenant auto-binding (T-08).
 *
 * DuckDB queries reference `$brand`, `$familyId`, and `$tz` inside SQL
 * literals. Screens supply only their own inputs; the dispatcher merges
 * the tenant fields from the active RequestContext before calling
 * `analytics.execute(sql, params)`.
 *
 * See data-access/spec.md §Tenant auto-binding.
 */

import type { RequestContext } from './types'

/**
 * Placeholders a SQL string actually references. DuckDB binds by NAME and
 * **rejects** any bound parameter the statement does not declare —
 * `Failed to retrieve bind parameter index`. Since tenant merging injects
 * `brand`/`familyId`/`tz` unconditionally, every query that omits one of
 * them from its SQL would fail at bind time.
 *
 * That is not hypothetical: `spo2.compareBaseline`,
 * `spo2.worthALookInsight` and `device.lastSyncedAt` in the ZivaOne
 * registry all reference `$userId`/`$brand`/`$familyId` but not `$tz`,
 * and all three failed the first time the SQL was executed against a real
 * engine.
 */
export function referencedPlaceholders(sql: string): Set<string> {
  const out = new Set<string>()
  const re = /\$([A-Za-z_][A-Za-z0-9_]*)/g
  for (let m = re.exec(sql); m !== null; m = re.exec(sql)) out.add(m[1])
  return out
}

/**
 * Merge caller input with `{ brand, familyId, tz }` from the
 * RequestContext. Tenant values win on collision — callers cannot forge
 * brand/familyId/tz (anti-forgery; see the collision test in
 * dispatcher.test.ts).
 *
 * Pass `sql` to restrict the result to placeholders that SQL actually
 * references. Omit it for engines that take a params bag rather than
 * binding by name.
 */
export function mergeTenantParams(
  input: unknown,
  ctx: RequestContext,
  sql?: string
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    brand: ctx.brand,
    familyId: ctx.familyId,
    tz: ctx.timezone,
  }
  const merged
    = input === null || input === undefined || typeof input !== 'object'
      // Non-object inputs (numbers, strings) are treated opaquely; the SQL
      // author is expected to reference them positionally. We still supply
      // the tenant fields so SQL literal binding works.
      ? base
      : { ...(input as Record<string, unknown>), ...base }

  if (sql === undefined) return merged

  // Drop anything the statement does not declare. Binding a parameter
  // DuckDB has never heard of is an error, not a no-op.
  const referenced = referencedPlaceholders(sql)
  return Object.fromEntries(
    Object.entries(merged).filter(([key]) => referenced.has(key))
  )
}
