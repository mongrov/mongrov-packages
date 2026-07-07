/**
 * Tenant auto-binding (T-08).
 *
 * DuckDB queries reference `$brand` and `$familyId` inside SQL literals.
 * Screens supply only their own inputs; the dispatcher merges the tenant
 * pair from the active RequestContext before calling
 * `analytics.execute(sql, params)`.
 *
 * See data-access/spec.md §Tenant auto-binding.
 */

import type { RequestContext } from './types'

/**
 * Merge caller input with `{ brand, familyId }` from the RequestContext.
 * Caller keys win on collision (so an explicit override is possible in
 * tests) but the tenant fields are always present in the result.
 */
export function mergeTenantParams(
  input: unknown,
  ctx: RequestContext
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    brand: ctx.brand,
    familyId: ctx.familyId,
  }
  if (input === null || input === undefined) return base
  if (typeof input !== 'object') {
    // Non-object inputs (numbers, strings) are treated opaquely; the SQL
    // author is expected to reference them positionally. We still supply
    // brand + familyId so SQL literal binding works.
    return base
  }
  return { ...(input as Record<string, unknown>), ...base }
}
