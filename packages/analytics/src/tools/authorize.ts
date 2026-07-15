/**
 * Authorize hooks for analytics tools.
 *
 * `familyScopeAuthorize` — grants access iff `args.userId` is either
 * the requester themselves or another member of the requester's
 * family. Family membership is looked up via a `family_member` table
 * that the app is expected to expose in the DuckDB catalog.
 *
 * TODO(T-11): once `createAnalyticsTools` factory lands, switch the
 * family-membership lookup to read the engine's `familyMembersProvider`
 * directly (see `AnalyticsConfig.familyMembersProvider`) rather than
 * requiring a SQL-visible `family_member` table. The current SQL path
 * lets us unit-test the hook without pulling the full factory into
 * scope.
 *
 * Both hooks fail closed on engine errors — a query throw returns
 * `false` rather than surfacing the error to the LLM.
 */

import type { AnalyticsEngine } from '../core/types'
import type { AuthorizeFn } from './types'

export function familyScopeAuthorize(analytics: AnalyticsEngine): AuthorizeFn {
  return async (_toolName, args, ctx) => {
    const targetUserId = args.userId
    if (typeof targetUserId !== 'string' || targetUserId.length === 0) {
      return false
    }
    if (targetUserId === ctx.requesterUserId) {
      return true
    }
    try {
      const rows = await analytics.execute<{ one: number }>(
        'SELECT 1 AS one FROM family_member '
        + 'WHERE family_id = $familyId AND user_id = $userId LIMIT 1',
        { familyId: ctx.familyId, userId: targetUserId },
      )
      return rows.length > 0
    }
    catch {
      return false
    }
  }
}

/**
 * `orgScopeAuthorize` — parity with family scope but against an
 * `org_member` table. Orgs are not first-class in v0.1.0; the ctx
 * `familyId` is treated as the org id until org membership is wired
 * through `RequestContext`.
 *
 * TODO(T-11): once orgs land, extend `ToolContext` with an `orgId`
 * field and switch the parameter binding here.
 */
export function orgScopeAuthorize(analytics: AnalyticsEngine): AuthorizeFn {
  return async (_toolName, args, ctx) => {
    const targetUserId = args.userId
    if (typeof targetUserId !== 'string' || targetUserId.length === 0) {
      return false
    }
    if (targetUserId === ctx.requesterUserId) {
      return true
    }
    try {
      const rows = await analytics.execute<{ one: number }>(
        'SELECT 1 AS one FROM org_member '
        + 'WHERE org_id = $orgId AND user_id = $userId LIMIT 1',
        { orgId: ctx.familyId, userId: targetUserId },
      )
      return rows.length > 0
    }
    catch {
      return false
    }
  }
}
