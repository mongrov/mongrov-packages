/**
 * Authorize hooks for analytics tools.
 *
 * `familyScopeAuthorize` — grants access iff `args.userId` is either
 * the requester themselves or another member of the requester's
 * family. When `config.familyMembersProvider` is supplied (the
 * factory path since T-11), membership resolves via that provider;
 * otherwise the legacy SQL path against a `family_member` table is
 * used (kept for standalone hook usage and backwards compat).
 *
 * Both hooks fail closed on any error — provider throws, engine
 * throws, missing/malformed args — return `false` rather than
 * surfacing the error to the LLM.
 */

import type { AnalyticsEngine, FamilyMembersProvider } from '../core/types'
import type { AuthorizeFn } from './types'

export interface AuthorizeConfig {
  /**
   * When present, membership is resolved via the provider instead of
   * SQL. This is the path wired by `createAnalyticsTools`.
   */
  familyMembersProvider?: FamilyMembersProvider
}

export function familyScopeAuthorize(
  analytics: AnalyticsEngine,
  config: AuthorizeConfig = {},
): AuthorizeFn {
  return async (_toolName, args, ctx) => {
    const targetUserId = args.userId
    if (typeof targetUserId !== 'string' || targetUserId.length === 0) {
      return false
    }
    if (targetUserId === ctx.requesterUserId) {
      return true
    }

    if (config.familyMembersProvider) {
      try {
        const members = await config.familyMembersProvider({
          brand: ctx.brand,
          familyId: ctx.familyId,
        })
        return members.includes(targetUserId)
      }
      catch {
        return false
      }
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
 * When `familyMembersProvider` is supplied, the same provider is
 * consulted (v0.1.0 shim — a dedicated `orgMembersProvider` will
 * split out once orgs land).
 */
export function orgScopeAuthorize(
  analytics: AnalyticsEngine,
  config: AuthorizeConfig = {},
): AuthorizeFn {
  return async (_toolName, args, ctx) => {
    const targetUserId = args.userId
    if (typeof targetUserId !== 'string' || targetUserId.length === 0) {
      return false
    }
    if (targetUserId === ctx.requesterUserId) {
      return true
    }

    if (config.familyMembersProvider) {
      try {
        const members = await config.familyMembersProvider({
          brand: ctx.brand,
          familyId: ctx.familyId,
        })
        return members.includes(targetUserId)
      }
      catch {
        return false
      }
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
