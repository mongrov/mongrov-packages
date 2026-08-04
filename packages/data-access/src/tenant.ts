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
 * Merge caller input with `{ brand, familyId, tz }` from the
 * RequestContext. Tenant values win on collision — callers cannot forge
 * brand/familyId/tz (anti-forgery; see the collision test in
 * dispatcher.test.ts).
 */
export function mergeTenantParams(
  input: unknown,
  ctx: RequestContext
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    brand: ctx.brand,
    familyId: ctx.familyId,
    tz: ctx.timezone,
  }
  if (input === null || input === undefined) return base
  if (typeof input !== 'object') {
    // Non-object inputs (numbers, strings) are treated opaquely; the SQL
    // author is expected to reference them positionally. We still supply
    // the tenant fields so SQL literal binding works.
    return base
  }
  return { ...(input as Record<string, unknown>), ...base }
}
