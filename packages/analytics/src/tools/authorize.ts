/**
 * Authorize hooks for analytics tools.
 *
 * `familyScopeAuthorize` — grants access iff `args.userId` is either
 * the requester themselves or another member of the requester's
 * family.
 *
 * Membership always resolves through the engine's configured
 * `FamilyMembersProvider` (principle 39 — "Rules engine and AI tools
 * share the same source of truth"): an explicitly-passed
 * `config.familyMembersProvider` wins, otherwise `analytics
 * .getFamilyMembers()` delegates to the one wired at `createAnalytics`.
 *
 * There is deliberately no SQL fallback. The spec's illustrative
 * `SELECT 1 FROM family_member ...` referenced a table that no DDL in
 * this package ever creates, so that path could only ever throw and
 * fail closed — silently denying every cross-member query on any
 * install that didn't pass a provider. Membership lives in the RxDB
 * Family doc, not in DuckDB.
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

    try {
      const members = config.familyMembersProvider
        ? await config.familyMembersProvider({
            brand: ctx.brand,
            familyId: ctx.familyId,
          })
        : await analytics.getFamilyMembers()
      return members.includes(targetUserId)
    }
    catch {
      return false
    }
  }
}

/**
 * `orgScopeAuthorize` — parity with family scope. Orgs are not
 * first-class in v0.1.0; the ctx `familyId` is treated as the org id
 * until org membership is wired through `RequestContext`, and the same
 * membership provider is consulted (v0.1.0 shim — a dedicated
 * `orgMembersProvider` splits out once orgs land).
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

    try {
      const members = config.familyMembersProvider
        ? await config.familyMembersProvider({
            brand: ctx.brand,
            familyId: ctx.familyId,
          })
        : await analytics.getFamilyMembers()
      return members.includes(targetUserId)
    }
    catch {
      return false
    }
  }
}
