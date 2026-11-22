/**
 * Answers (turns): the per-answer call cap (default 4) and the answer's cache
 * of repeated calls, both in the framework since 0.62.0.
 */

import type { PackTool } from '../../core/packs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { resetPacks } from '../../core/packs'
import { CALL_LIMIT_GUIDANCE, DUPLICATE_CALL_GUIDANCE, markMcpCall } from '../wrap'
import { call, okOutcome, seriesTool, setup } from './support/structured'

afterEach(() => resetPacks())

function legacyTool(text = 'Values for 2026-11-21: 42.'): PackTool & { name: string } {
  return {
    name: 'getText',
    description: 'A text tool.',
    inputSchema: z.object({ userId: z.string(), day: z.string().optional() }),
    impl: async () => ({ text, rowCount: 1, bytes: new TextEncoder().encode(text).byteLength }),
  }
}

describe('the per-answer call cap', () => {
  it('refuses the 5th call with call_limit, audits it, and delivers it to onResult', async () => {
    const impl = vi.fn(async () => okOutcome())
    const { handle, audit, events } = setup()
    const t = handle.add(seriesTool(impl))
    const turn = handle.beginTurn({ id: 'answer-1' })
    const periods = ['this_week', 'last_7_days', 'last_30_days'] as const
    for (const [i, p] of [...periods, undefined].entries())
      expect(await call(t, { userId: `alice`, ...(p ? { period: p } : {}) }), `call ${i + 1}`).toContain('status: ok')
    // Distinct arguments (an unknown key would be stripped, making it a cached repeat).
    const fifth = await call(t, { userId: 'carol', period: 'this_week' })
    expect(fifth).toBe([
      'status: error (call_limit)',
      'error: The tool call limit for this question is reached.',
      `note: ${CALL_LIMIT_GUIDANCE}`,
    ].join('\n'))
    expect(impl).toHaveBeenCalledTimes(4)
    expect(audit.records.map(r => [r.outcome, r.callIndex, r.turnId, r.errorCode])).toEqual([
      ['success', 1, 'answer-1', null],
      ['success', 2, 'answer-1', null],
      ['success', 3, 'answer-1', null],
      ['success', 4, 'answer-1', null],
      ['call_limit', 5, 'answer-1', 'call_limit'],
    ])
    expect(events[4]).toMatchObject({ auditOutcome: 'call_limit', turnId: 'answer-1', callIndex: 5 })
    expect(turn.end()).toMatchObject({ calls: 5, refused: 1 })
  })

  it('a compatibility tool past the cap gets exactly the 0.61.1 app\'s budget-spent text', async () => {
    const { handle, audit } = setup({ callLimit: { perTurn: 1 } })
    const t = handle.add(legacyTool())
    handle.beginTurn()
    await call(t, { userId: 'alice', day: 'today' })
    expect(await call(t, { userId: 'alice', day: 'yesterday' })).toBe(CALL_LIMIT_GUIDANCE)
    expect(CALL_LIMIT_GUIDANCE).toBe('No more tool calls for this question. Answer now with what you already have.')
    expect(audit.records[1]).toMatchObject({ outcome: 'call_limit', resultStatus: 'error', errorCode: 'call_limit' })
  })

  it('calls with bad arguments count, so a model cannot loop on them', async () => {
    const { handle, audit } = setup({ callLimit: { perTurn: 2 } })
    const t = handle.add(seriesTool())
    handle.beginTurn()
    expect(await call(t, { userId: 'alice', period: 'bad' })).toContain('invalid_args')
    expect(await call(t, { userId: 'alice', period: 'worse' })).toContain('invalid_args')
    expect(await call(t, { userId: 'alice', period: 'worst' })).toContain('call_limit')
    expect(audit.records.map(r => r.outcome)).toEqual(['invalid_args', 'invalid_args', 'call_limit'])
  })

  it('the cap is per answer: a new turn starts over, and no turn means no cap', async () => {
    const { handle, audit } = setup({ callLimit: { perTurn: 1 } })
    const t = handle.add(seriesTool())
    let turn = handle.beginTurn()
    await call(t, { userId: 'alice', period: 'this_week' })
    expect(await call(t, { userId: 'alice', period: 'last_7_days' })).toContain('call_limit')
    turn.end()
    turn = handle.beginTurn()
    expect(await call(t, { userId: 'alice', period: 'last_7_days' })).toContain('status: ok')
    turn.end()
    for (let i = 0; i < 6; i++)
      expect(await call(t, { userId: 'alice', period: 'last_30_days', n: i })).toContain('status: ok')
    expect(audit.records.slice(3).every(r => r.turnId === null && r.callIndex === null)).toBe(true)
  })

  it('MCP calls never join an open answer', async () => {
    const { handle, audit, events } = setup({ callLimit: { perTurn: 1 } })
    const t = handle.add(seriesTool())
    handle.beginTurn()
    await call(t, { userId: 'alice', period: 'this_week' })
    const options = { toolCallId: 'mcp:getSeries', messages: [] }
    markMcpCall(options)
    expect(await call(t, { userId: 'alice', period: 'last_7_days' }, options)).toContain('status: ok')
    expect(audit.records[1]).toMatchObject({ turnId: null, callIndex: null })
    expect(events[1].source).toBe('mcp')
  })

  it('callLimit: false turns the cap and the cache off', async () => {
    const impl = vi.fn(async () => okOutcome())
    const { handle } = setup({ callLimit: false })
    const t = handle.add(seriesTool(impl))
    handle.beginTurn()
    for (let i = 0; i < 6; i++)
      expect(await call(t, { userId: 'alice' })).toContain('status: ok')
    expect(impl).toHaveBeenCalledTimes(6)
  })
})

describe('the answer\'s cache', () => {
  it('the first repeat is served from cache, audited cached, and not counted', async () => {
    const impl = vi.fn(async () => okOutcome())
    const { handle, audit, events } = setup({ callLimit: { perTurn: 2 } })
    const t = handle.add(seriesTool(impl))
    const turn = handle.beginTurn()
    const first = await call(t, { userId: 'alice', period: 'this_week' })
    // Same arguments in another key order.
    const again = await call(t, { period: 'this_week', userId: 'alice' })
    expect(again).toBe(first)
    expect(impl).toHaveBeenCalledTimes(1)
    // Still one counted call left.
    expect(await call(t, { userId: 'alice', period: 'last_7_days' })).toContain('status: ok')
    expect(await call(t, { userId: 'alice', period: 'last_30_days' })).toContain('call_limit')
    expect(audit.records.map(r => [r.callIndex, r.outcome, r.cached])).toEqual([
      [1, 'success', false],
      [2, 'success', true],
      [3, 'success', false],
      [4, 'call_limit', false],
    ])
    expect(audit.records[1].resultDigest).toBe(audit.records[0].resultDigest)
    expect(audit.records[1].renderChars).toBe(first.length)
    expect(events.map(e => e.cached)).toEqual([false, true, false, false])
    expect(turn.end()).toMatchObject({ calls: 4, refused: 1 })
  })

  it('the second and later identical repeats are refused with one short line, never the result', async () => {
    const impl = vi.fn(async () => okOutcome())
    const { handle, events } = setup({ callLimit: { perTurn: 10 } })
    const t = handle.add(seriesTool(impl))
    const turn = handle.beginTurn({ id: 'loop' })
    const first = await call(t, { userId: 'alice', period: 'this_week' })
    expect(await call(t, { userId: 'alice', period: 'this_week' })).toBe(first)
    const refused: string[] = []
    for (let i = 0; i < 4; i++)
      refused.push(await call(t, { userId: 'alice', period: 'this_week' }))
    expect(refused).toEqual(Array.from({ length: 4 }, () => DUPLICATE_CALL_GUIDANCE))
    expect(DUPLICATE_CALL_GUIDANCE).toBe('You already have this result above; answer from it.')
    expect(DUPLICATE_CALL_GUIDANCE.length).toBeLessThan(60)
    expect(impl).toHaveBeenCalledTimes(1)
    expect(events[2]).toMatchObject({
      cached: true,
      auditOutcome: 'call_limit',
      rendered: DUPLICATE_CALL_GUIDANCE,
      outcome: { status: 'error', data: null, error: { code: 'call_limit', message: DUPLICATE_CALL_GUIDANCE }, guidance: [] },
    })
    // The answer's character budget is spent by one line per refusal, not one result.
    expect(turn.end()).toEqual({ calls: 6, refused: 4, chars: first.length * 2 + DUPLICATE_CALL_GUIDANCE.length * 4 })
  })

  it('audits refused repeats: call_limit, error status and code, cached, turn and call index', async () => {
    const { handle, audit } = setup()
    const t = handle.add(seriesTool())
    handle.beginTurn({ id: 'answer-9' })
    for (let i = 0; i < 4; i++)
      await call(t, { userId: 'alice' })
    expect(audit.records.map(r => ({
      outcome: r.outcome,
      resultStatus: r.resultStatus,
      errorCode: r.errorCode,
      cached: r.cached,
      turnId: r.turnId,
      callIndex: r.callIndex,
      errorMessage: r.errorMessage,
    }))).toEqual([
      { outcome: 'success', resultStatus: 'ok', errorCode: null, cached: false, turnId: 'answer-9', callIndex: 1, errorMessage: null },
      { outcome: 'success', resultStatus: 'ok', errorCode: null, cached: true, turnId: 'answer-9', callIndex: 2, errorMessage: null },
      { outcome: 'call_limit', resultStatus: 'error', errorCode: 'call_limit', cached: true, turnId: 'answer-9', callIndex: 3, errorMessage: 'identical repeat 2' },
      { outcome: 'call_limit', resultStatus: 'error', errorCode: 'call_limit', cached: true, turnId: 'answer-9', callIndex: 4, errorMessage: 'identical repeat 3' },
    ])
    expect(audit.records[2].renderChars).toBe(DUPLICATE_CALL_GUIDANCE.length)
    expect(audit.records[2].resultBytes).toBeNull()
  })

  it('different arguments are not deduped', async () => {
    const impl = vi.fn(async () => okOutcome())
    const { handle, audit } = setup({ callLimit: { perTurn: 10 } })
    const t = handle.add(seriesTool(impl))
    handle.beginTurn()
    for (const p of ['this_week', 'last_7_days', 'this_week', 'last_7_days', 'last_30_days'] as const)
      expect(await call(t, { userId: 'alice', period: p })).toContain('status: ok')
    expect(await call(t, { userId: 'alice' })).toContain('status: ok')
    expect(impl).toHaveBeenCalledTimes(4)
    expect(audit.records.map(r => r.cached)).toEqual([false, false, true, true, false, false])
    // Each key has its own repeat count: one more of each is now refused.
    expect(await call(t, { userId: 'alice', period: 'this_week' })).toBe(DUPLICATE_CALL_GUIDANCE)
    expect(await call(t, { userId: 'alice' })).toContain('status: ok')
  })

  it('a refused repeat counts toward the cap, so a loop also runs into it', async () => {
    const impl = vi.fn(async () => okOutcome())
    const { handle, audit } = setup({ callLimit: { perTurn: 2 } })
    const t = handle.add(seriesTool(impl))
    const turn = handle.beginTurn()
    await call(t, { userId: 'alice', period: 'this_week' }) // counted 1
    await call(t, { userId: 'alice', period: 'this_week' }) // served, not counted
    expect(await call(t, { userId: 'alice', period: 'this_week' })).toBe(DUPLICATE_CALL_GUIDANCE) // counted 2
    // The cap is now spent: a new call is refused.
    expect(await call(t, { userId: 'alice', period: 'last_7_days' })).toContain('call_limit')
    expect(audit.records.map(r => [r.outcome, r.cached, r.errorMessage])).toEqual([
      ['success', false, null],
      ['success', true, null],
      ['call_limit', true, 'identical repeat 2'],
      ['call_limit', false, null],
    ])
    expect(impl).toHaveBeenCalledTimes(1)
    expect(turn.end()).toMatchObject({ calls: 4, refused: 2 })
  })

  it('a compatibility tool gets the same one line on a refused repeat', async () => {
    const impl = vi.fn(async () => ({ text: 'x', rowCount: 1, bytes: 1 }))
    const { handle, audit } = setup()
    const t = handle.add({ ...legacyTool(), impl })
    handle.beginTurn()
    await call(t, { userId: 'alice' })
    expect(await call(t, { userId: 'alice' })).toBe('x')
    expect(await call(t, { userId: 'alice' })).toBe(DUPLICATE_CALL_GUIDANCE)
    expect(audit.records[2]).toMatchObject({ cached: true, outcome: 'call_limit', errorCode: 'call_limit' })
  })

  it('MCP calls repeat freely, outside any answer', async () => {
    const impl = vi.fn(async () => okOutcome())
    const { handle, audit } = setup()
    const t = handle.add(seriesTool(impl))
    handle.beginTurn()
    for (let i = 0; i < 4; i++) {
      const options = { toolCallId: `mcp:${i}`, messages: [] }
      markMcpCall(options)
      expect(await call(t, { userId: 'alice' }, options)).toContain('status: ok')
    }
    expect(impl).toHaveBeenCalledTimes(4)
    expect(audit.records.every(r => !r.cached && r.turnId === null)).toBe(true)
  })

  it('defaults (no `.default()` sent vs sent) are the same call once validated', async () => {
    const impl = vi.fn(async () => okOutcome())
    const { handle } = setup()
    const t = handle.add({ ...seriesTool(impl), inputSchema: z.object({ userId: z.string(), period: z.enum(['this_week', 'last_7_days']).default('this_week') }) })
    handle.beginTurn()
    await call(t, { userId: 'alice' })
    await call(t, { userId: 'alice', period: 'this_week' })
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('refusals are not cached: a rate-limited call is retried for real', async () => {
    const impl = vi.fn(async () => okOutcome())
    let allow = false
    const { handle, audit } = setup({ authorize: async () => allow })
    const t = handle.add(seriesTool(impl))
    handle.beginTurn()
    expect(await call(t, { userId: 'alice' })).toContain('not_authorized')
    allow = true
    expect(await call(t, { userId: 'alice' })).toContain('status: ok')
    expect(audit.records.map(r => r.cached)).toEqual([false, false])
  })

  it('compatibility tools are cached too', async () => {
    const impl = vi.fn(async () => ({ text: 'x', rowCount: 1, bytes: 1 }))
    const { handle, audit } = setup()
    const t = handle.add({ ...legacyTool(), impl })
    handle.beginTurn()
    await call(t, { userId: 'alice' })
    expect(await call(t, { userId: 'alice' })).toBe('x')
    expect(impl).toHaveBeenCalledTimes(1)
    expect(audit.records[1]).toMatchObject({ cached: true, outcome: 'success', resultStatus: 'ok', resultBytes: 1 })
  })

  it('beginTurn closes the previous answer; end() is idempotent', async () => {
    const impl = vi.fn(async () => okOutcome())
    const { handle } = setup()
    const t = handle.add(seriesTool(impl))
    const a = handle.beginTurn({ id: 'a' })
    await call(t, { userId: 'alice' })
    const b = handle.beginTurn({ id: 'b' })
    await call(t, { userId: 'alice' })
    expect(impl).toHaveBeenCalledTimes(2)
    expect(a.end()).toMatchObject({ calls: 1 })
    expect(b.end()).toMatchObject({ calls: 1 })
    expect(b.end()).toMatchObject({ calls: 1 })
  })
})
