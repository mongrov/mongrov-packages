/**
 * Sprint 5 T-15c — insight dismissal.
 *
 * Backs the app registry's `insight.dismiss` mutation. Dismissal preserves
 * the row (principle 51); only `dismissed_at` changes.
 */

import { describe, expect, it } from 'vitest'

import { AnalyticsError } from '../errors'
import { dismissInsight } from '../insight'

const OWNED = { user_id: 'alice', metric: 'spo2', dismissed_at: null }

/** Engine stub: scripted SELECT result, recorded UPDATEs. */
function engineWith(row: Record<string, unknown> | undefined) {
  const calls: { sql: string, params: Record<string, unknown> }[] = []
  return {
    calls,
    analytics: {
      async execute(sql: string, params?: Record<string, unknown>) {
        calls.push({ sql, params: params ?? {} })
        return sql.startsWith('SELECT') && row ? [row] : []
      },
    },
  }
}

describe('dismissInsight', () => {
  it('stamps dismissed_at and emits insight:dismissed', async () => {
    const emitted: { name: string, payload: unknown }[] = []
    const { analytics, calls } = engineWith(OWNED)

    await dismissInsight(
      { insightId: 'ins_1', userId: 'alice' },
      { analytics: analytics as never, eventBus: { emit: (n: string, p: unknown) => emitted.push({ name: n, payload: p }) } as never },
    )

    const update = calls.find(c => c.sql.includes('UPDATE insight'))
    expect(update).toBeDefined()
    expect(update!.sql).toContain('SET dismissed_at = now()')
    expect(update!.params).toEqual({ insightId: 'ins_1', userId: 'alice' })

    expect(emitted).toEqual([{
      name: 'insight:dismissed',
      payload: { insightId: 'ins_1', userId: 'alice', metric: 'spo2' },
    }])
  })

  it('preserves the row — no DELETE anywhere (principle 51)', async () => {
    const { analytics, calls } = engineWith(OWNED)
    await dismissInsight({ insightId: 'ins_1', userId: 'alice' }, { analytics: analytics as never })
    expect(calls.some(c => /DELETE/i.test(c.sql))).toBe(false)
  })

  it('scopes the UPDATE by userId as well as insightId', async () => {
    // Defence in depth: even if the ownership probe were bypassed, the
    // write itself cannot touch another user's row.
    const { analytics, calls } = engineWith(OWNED)
    await dismissInsight({ insightId: 'ins_1', userId: 'alice' }, { analytics: analytics as never })
    const update = calls.find(c => c.sql.includes('UPDATE insight'))!
    expect(update.sql).toContain('user_id = $userId')
  })
})

describe('authorization', () => {
  it('rejects dismissing another user\'s insight', async () => {
    const { analytics, calls } = engineWith({ ...OWNED, user_id: 'bob' })

    await expect(
      dismissInsight({ insightId: 'ins_1', userId: 'alice' }, { analytics: analytics as never }),
    ).rejects.toBeInstanceOf(AnalyticsError)

    expect(calls.some(c => c.sql.includes('UPDATE insight'))).toBe(false)
  })

  it('gives the same error for missing and not-owned', async () => {
    // Distinguishing them would let a caller probe for the existence of
    // another user's insights.
    const missing = engineWith(undefined)
    const notOwned = engineWith({ ...OWNED, user_id: 'bob' })

    const err1 = await dismissInsight({ insightId: 'x', userId: 'alice' }, { analytics: missing.analytics as never }).catch(e => e as Error)
    const err2 = await dismissInsight({ insightId: 'x', userId: 'alice' }, { analytics: notOwned.analytics as never }).catch(e => e as Error)

    expect(err1.message).toBe(err2.message)
  })

  it('emits no event on a rejected dismissal', async () => {
    const emitted: string[] = []
    const { analytics } = engineWith({ ...OWNED, user_id: 'bob' })
    await dismissInsight(
      { insightId: 'ins_1', userId: 'alice' },
      { analytics: analytics as never, eventBus: { emit: (n: string) => emitted.push(n) } as never },
    ).catch(() => {})
    expect(emitted).toEqual([])
  })

  it.each([
    ['empty insightId', { insightId: '', userId: 'alice' }],
    ['empty userId', { insightId: 'ins_1', userId: '' }],
  ])('rejects %s without touching the engine', async (_label, args) => {
    const { analytics, calls } = engineWith(OWNED)
    await expect(
      dismissInsight(args, { analytics: analytics as never }),
    ).rejects.toBeInstanceOf(AnalyticsError)
    expect(calls).toHaveLength(0)
  })
})

describe('idempotency', () => {
  it('a second dismissal is a no-op that keeps the original timestamp', async () => {
    const emitted: string[] = []
    const { analytics, calls } = engineWith({
      ...OWNED,
      dismissed_at: '2026-07-01T00:00:00Z',
    })

    await dismissInsight(
      { insightId: 'ins_1', userId: 'alice' },
      { analytics: analytics as never, eventBus: { emit: (n: string) => emitted.push(n) } as never },
    )

    // No UPDATE — a double-tap on a slow connection must not rewrite when
    // the card was dismissed.
    expect(calls.some(c => c.sql.includes('UPDATE insight'))).toBe(false)
    expect(emitted).toEqual([])
  })
})
