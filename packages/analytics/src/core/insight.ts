/**
 * Insight dismissal (Sprint 5 §7b / T-15c).
 *
 * Backs the app registry's `insight.dismiss` mutation. Dismissal stamps
 * `dismissed_at` rather than deleting the row (principle 51): registry
 * queries filter `WHERE dismissed_at IS NULL` by default, so the card
 * disappears from the feed, but the row survives for a future "restore"
 * surface and for audit.
 *
 * Note there is no migration here. The Sprint 5 spec lists
 * `insight.dismissed_at` as an `ALTER TABLE` at migration v4, but the
 * column already ships in the baseline DDL and migration v3 backfills it
 * for pre-0.7.0 installs — so T-15b is satisfied and an ALTER would be a
 * no-op against a column that exists.
 */

import { AnalyticsError } from './errors'
import type { AnalyticsEngine, EventBus } from './types'

export interface DismissInsightArgs {
  insightId: string
  userId: string
}

export interface DismissInsightDeps {
  analytics: Pick<AnalyticsEngine, 'execute'>
  eventBus?: EventBus
}

/** Row shape returned by the ownership probe. */
interface OwnerRow {
  user_id: string
  metric: string
  dismissed_at: string | null
}

/**
 * Stamp `dismissed_at` on one insight.
 *
 * Authorization is by ownership: the caller must be the user the insight
 * was raised for. This is deliberately stricter than family scope — a
 * family member can *see* aggregate data, but dismissing someone else's
 * health card is a write on their feed, and there is no product surface
 * that asks for it.
 *
 * Idempotent: dismissing an already-dismissed insight is a no-op that
 * preserves the original timestamp and re-emits no event, so a double-tap
 * on a slow connection cannot rewrite history.
 *
 * @throws `AnalyticsError('query_failed')` when the insight does not exist
 *   or belongs to another user. The two cases share a message on purpose —
 *   distinguishing them would let a caller probe for the existence of
 *   another user's insights.
 */
export async function dismissInsight(
  args: DismissInsightArgs,
  deps: DismissInsightDeps,
): Promise<void> {
  const { insightId, userId } = args

  if (typeof insightId !== 'string' || insightId.length === 0) {
    throw new AnalyticsError('query_failed', 'dismissInsight: insightId is required')
  }
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new AnalyticsError('query_failed', 'dismissInsight: userId is required')
  }

  const rows = await deps.analytics.execute<OwnerRow>(
    `SELECT user_id, metric, dismissed_at::VARCHAR AS dismissed_at
     FROM insight WHERE insight_id = $insightId LIMIT 1`,
    { insightId },
  )

  const row = rows[0]
  if (!row || row.user_id !== userId) {
    throw new AnalyticsError(
      'query_failed',
      `dismissInsight: insight ${insightId} not found for this user`,
    )
  }

  if (row.dismissed_at !== null && row.dismissed_at !== undefined) {
    // Already dismissed — keep the original stamp and stay quiet.
    return
  }

  await deps.analytics.execute(
    `UPDATE insight SET dismissed_at = now()
     WHERE insight_id = $insightId AND user_id = $userId`,
    { insightId, userId },
  )

  // Registry queries filtering on `dismissed_at IS NULL` invalidate on this.
  deps.eventBus?.emit('insight:dismissed', {
    insightId,
    userId,
    metric: row.metric,
  })
}
