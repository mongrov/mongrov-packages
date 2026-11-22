/**
 * The compatibility path: an impl that returns `ToolResult`
 * (`{ text, rowCount, bytes }`) keeps working in 0.62.0, byte for byte —
 * the model gets the same text, after the same byte budget, and the same
 * refusal strings as 0.61.1. The 0.61.1 suites (wrap, handle-wrap, budget,
 * factory, ai-sdk-loop) run unchanged against this release; this file adds
 * what is new around them: the audit's v3 fields, `onResult`, and answers.
 */

import type { PackTool } from '../../core/packs'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { definePack, registerPack, resetPacks } from '../../core/packs'
import { applyOutputBudget } from '../budget'
import { call, setup } from './support/structured'

afterEach(() => resetPacks())

const bytes = (t: string): number => new TextEncoder().encode(t).byteLength

function textTool(text: string, rowCount = 1): PackTool & { name: string } {
  return {
    name: 'getText',
    description: 'A text tool.',
    inputSchema: z.object({ userId: z.string(), days: z.number().int().min(1).max(30).default(7) }),
    impl: async () => ({ text, rowCount, bytes: bytes(text) }),
  }
}

/** 60 dated rows, oldest first, between a header and a summary: over the 4096-byte budget. */
const LONG = ['Values, last 60 days:', ...Array.from({ length: 60 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 8, 23 + i)).toISOString().slice(0, 10)
  return `  ${d}: average 42.0, lowest 30.0, highest 55.0, from 120 records`
}), 'Average 42.0 over 60 days.'].join('\n')

describe('ToolResult impls (compatibility)', () => {
  it('the model gets the impl\'s text unchanged when it fits', async () => {
    const { handle } = setup()
    const t = handle.wrap('getText', textTool('Values for 2026-11-21: 42.'))
    expect(await call(t, { userId: 'alice' })).toBe('Values for 2026-11-21: 42.')
  })

  it('over the byte budget: exactly what 0.61.1\'s applyOutputBudget returns (oldest rows first)', async () => {
    const { handle, audit } = setup()
    const t = handle.wrap('getText', textTool(LONG, 60))
    const expected = applyOutputBudget({ text: LONG, rowCount: 60, bytes: bytes(LONG) }, { maxBytes: 4096, maxRows: 100 })
    const text = await call(t, { userId: 'alice' })
    expect(text).toBe(expected.text)
    expect(text).toContain('[truncated:')
    expect(text.endsWith('Average 42.0 over 60 days.')).toBe(true)
    // No character budget applies to compatibility text, in an answer or not.
    expect(text.length).toBeGreaterThan(1200)
    expect(audit.records[0]).toMatchObject({ resultBytes: expected.bytes, resultRowCount: 60 })
  })

  it('the character budget of an answer does not touch compatibility text either', async () => {
    const { handle } = setup()
    const t = handle.wrap('getText', textTool(LONG, 60))
    handle.beginTurn()
    const a = await call(t, { userId: 'alice', days: 1 })
    const b = await call(t, { userId: 'alice', days: 2 })
    expect(b).toBe(a)
  })

  it.each([
    ['refused arguments', { userId: 'alice', days: 0 }, {}, 'Invalid arguments: days must be a whole number from 1 to 30 (got 0).'],
    ['rate limited', { userId: 'alice' }, { rateLimit: { perToolPerMinute: 0, perToolPerHour: 0, perUserPerMinute: 0 } }, 'Rate limit exceeded. Try again shortly.'],
    ['not authorized', { userId: 'bob' }, { authorize: async () => false }, 'Not authorized to access that user\'s data.'],
  ] as const)('%s: the 0.61.1 refusal text', async (_case, args, config, text) => {
    const { handle } = setup(config as never)
    const t = handle.wrap('getText', textTool('x'))
    expect(await call(t, args)).toBe(text)
  })

  it('a throwing impl or a copy-guard breach: "Tool call failed." as before', async () => {
    registerPack(definePack({
      name: 'guardtest',
      copyGuard: (text: string) => {
        if (text.includes('forbidden'))
          throw new Error('forbidden word')
      },
    }))
    const { handle, audit } = setup()
    const guarded = handle.wrap('getText', textTool('a forbidden word'))
    const throwing = handle.wrap('getThrow', { ...textTool('x'), impl: async () => { throw new Error('boom') } })
    expect(await call(guarded, { userId: 'alice' })).toBe('Tool call failed.')
    expect(await call(throwing, { userId: 'alice' })).toBe('Tool call failed.')
    expect(audit.records.map(r => [r.outcome, r.errorCode, r.errorMessage])).toEqual([
      ['error', 'copy_guard', 'forbidden word'],
      ['error', 'internal', 'boom'],
    ])
  })

  it('the audit gets result_status from rowCount (ok / empty), the digest and size', async () => {
    const { handle, audit } = setup()
    await call(handle.wrap('getText', textTool('Values for 2026-11-21: 42.', 1)), { userId: 'alice' })
    await call(handle.wrap('getNone', textTool('No values in the last 7 days.', 0)), { userId: 'alice' })
    expect(audit.records.map(r => [r.outcome, r.resultStatus, r.errorCode, r.renderChars, r.truncatedItems])).toEqual([
      ['success', 'ok', null, 26, null],
      ['success', 'empty', null, 29, null],
    ])
    expect(audit.records[0].resultDigest).toMatch(/^[0-9a-f]{16}$/)
  })

  it('onResult: legacy, with an envelope that carries no data', async () => {
    const { handle, events } = setup()
    await call(handle.wrap('getText', textTool('Values for 2026-11-21: 42.')), { userId: 'alice' })
    expect(events[0]).toMatchObject({
      toolName: 'getText',
      legacy: true,
      rendered: 'Values for 2026-11-21: 42.',
      outcome: { status: 'ok', data: null, window: null, asOf: null, error: null, truncated: null, guidance: [] },
    })
  })

  it('pack tools on the compatibility path are listed and run as before', async () => {
    registerPack(definePack({ name: 'textpack', tools: { getText: textTool('From a pack.') } }))
    const { handle } = setup()
    expect(Object.keys(handle.tools)).toContain('getText')
    expect(await call(handle.tools.getText, { userId: 'alice' })).toBe('From a pack.')
  })
})
