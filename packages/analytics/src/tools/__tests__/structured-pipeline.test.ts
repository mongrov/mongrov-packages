/**
 * The structured chain (0.62.0): input check → answer cap → rate limit →
 * authorize → execute → output check → copy guard → render → budget → audit
 * → onResult → one string to the model.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { definePack, registerPack, resetPacks } from '../../core/packs'
import { outcome } from '../outcome'
import { renderers } from '../render'
import { ToolOutputError, UNREADABLE_GUIDANCE } from '../wrap'
import { call, ctx, okOutcome, seriesData, seriesTool, setup, WINDOW } from './support/structured'

afterEach(() => resetPacks())

describe('pipeline order', () => {
  it('runs input check, cap, rate limit, authorize, execute, output check, copy guard, render, audit, onResult in that order', async () => {
    const order: string[] = []
    const outputSchema = z.object({}).passthrough().transform((d) => {
      order.push('output check')
      return d
    })
    registerPack(definePack({
      name: 'ordertest',
      copyGuard: (text: string) => {
        if (text.startsWith('status:'))
          order.push('copy guard (rendered)')
        else if (!order.includes('copy guard'))
          order.push('copy guard')
      },
    }))
    const inputSchema = z.object({ userId: z.string() }).transform((v) => {
      order.push('input check')
      return v
    })
    const { handle, audit } = setup({
      rateLimit: { perToolPerMinute: 20, perToolPerHour: 200, perUserPerMinute: 60 },
      authorize: async () => {
        order.push('authorize')
        return true
      },
      render: {
        default: (o, c) => {
          order.push('render')
          return renderers.lines(o, c)
        },
      },
      onResult: () => order.push('onResult'),
    })
    const record = handle.auditWriter.record
    handle.auditWriter.record = (e) => {
      order.push('audit')
      record(e)
    }
    const turn = handle.beginTurn()
    const t = handle.add({
      ...seriesTool(() => {
        order.push('execute')
        return okOutcome()
      }),
      inputSchema,
      outputSchema,
    })
    await call(t, { userId: 'alice' })
    turn.end()
    expect(order).toEqual([
      'input check',
      'authorize',
      'execute',
      'output check',
      'copy guard',
      'render',
      'copy guard (rendered)',
      'audit',
      'onResult',
    ])
    expect(audit.records[0]).toMatchObject({ outcome: 'success', callIndex: 1 })
  })

  it('checks the answer cap before the rate limit and authorization', async () => {
    const authorize = vi.fn(async () => true)
    const { handle, audit } = setup({ authorize, callLimit: { perTurn: 1 } })
    const t = handle.add(seriesTool())
    handle.beginTurn()
    await call(t, { userId: 'alice', period: 'this_week' })
    const text = await call(t, { userId: 'alice', period: 'last_7_days' })
    expect(text).toContain('status: error (call_limit)')
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(audit.records.map(r => r.outcome)).toEqual(['success', 'call_limit'])
  })
})

describe('statuses', () => {
  it('ok: the model gets the rendered envelope; the audit gets status, digest and size, not content', async () => {
    const { handle, audit, events } = setup()
    const t = handle.add(seriesTool())
    const text = await call(t, { userId: 'alice' })
    expect(text.split('\n').slice(0, 4)).toEqual([
      'status: ok',
      'window: 2026-11-15 to 2026-11-21 (last_7_days, today partial) Asia/Kolkata',
      'as_of: 12 min ago',
      'note: Today is still in progress; say so far.',
    ])
    expect(audit.records).toHaveLength(1)
    const row = audit.records[0]
    expect(row).toMatchObject({
      outcome: 'success',
      resultStatus: 'ok',
      errorCode: null,
      renderChars: text.length,
      resultBytes: new TextEncoder().encode(text).byteLength,
      resultRowCount: 3,
      truncatedItems: 0,
      turnId: null,
      callIndex: null,
      cached: false,
    })
    expect(row.resultDigest).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(row)).not.toContain('Steady')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ toolName: 'getSeries', source: 'ai', rendered: text, legacy: false, cached: false, auditOutcome: 'success' })
    expect(events[0].outcome.data).toEqual(seriesData())
  })

  it('empty and insufficient pass through with their status', async () => {
    const { handle, audit } = setup()
    const empty = handle.add(seriesTool(() => outcome.empty({ window: WINDOW, asOf: null })))
    expect(await call(empty, { userId: 'alice' })).toBe([
      'status: empty',
      'window: 2026-11-15 to 2026-11-21 (last_7_days, today partial) Asia/Kolkata',
      'as_of: unknown',
    ].join('\n'))
    resetPacks()
    const { handle: h2, audit: a2 } = setup()
    const insufficient = h2.add(seriesTool(() => outcome.insufficient({ ...seriesData(1), avgValue: null }, { window: WINDOW, asOf: null, guidance: ['Too few days to judge yet.'] })))
    const text = await call(insufficient, { userId: 'alice' })
    expect(text).toContain('status: insufficient')
    expect(text).toContain('avgValue: null')
    expect(audit.records[0].resultStatus).toBe('empty')
    expect(a2.records[0].resultStatus).toBe('insufficient')
  })

  it('outcome.invalid: the impl refuses its arguments — invalid_args, audited, message to the model', async () => {
    const { handle, audit, events } = setup()
    const t = handle.add(seriesTool(() => outcome.invalid('period must be within the last 90 days; today is 2026-11-21')))
    const text = await call(t, { userId: 'alice' })
    expect(text).toBe('status: error (invalid_args)\nerror: period must be within the last 90 days; today is 2026-11-21')
    expect(audit.records[0]).toMatchObject({ outcome: 'invalid_args', resultStatus: 'error', errorCode: 'invalid_args' })
    expect(events[0].outcome.error).toMatchObject({ code: 'invalid_args', retryable: true })
  })

  it('a throwing impl is internal: a generic message and the unreadable guidance, never the error text', async () => {
    const { handle, audit, events } = setup()
    const t = handle.add(seriesTool(() => {
      throw new Error('Binder Error: column secret_col not found')
    }))
    const text = await call(t, { userId: 'alice' })
    expect(text).toBe(`status: error (internal)\nerror: Tool call failed.\nnote: ${UNREADABLE_GUIDANCE}`)
    expect(text).not.toContain('secret_col')
    expect(audit.records[0]).toMatchObject({ outcome: 'error', errorCode: 'internal', errorMessage: 'Binder Error: column secret_col not found' })
    expect(events[0].outcome.status).toBe('error')
  })

  it('a schema refusal of the arguments renders as an error envelope with the 0.61.1 message', async () => {
    const { handle, audit } = setup()
    const t = handle.add(seriesTool())
    const text = await call(t, { userId: 'alice', period: 'next_year' })
    expect(text).toBe('status: error (invalid_args)\nerror: Invalid arguments: period must be one of "this_week", "last_7_days", "last_30_days" (got "next_year").')
    expect(audit.records[0]).toMatchObject({ outcome: 'invalid_args', errorCode: 'invalid_args' })
  })

  it('rate limited and not authorized are refusals with their own codes', async () => {
    const { handle, audit } = setup({
      rateLimit: { perToolPerMinute: 1, perToolPerHour: 200, perUserPerMinute: 60 },
    })
    const t = handle.add(seriesTool())
    await call(t, { userId: 'alice' })
    expect(await call(t, { userId: 'alice' })).toBe('status: error (rate_limited)\nerror: Rate limit exceeded. Try again shortly.')
    resetPacks()
    const s2 = setup({ authorize: async () => false })
    const t2 = s2.handle.add(seriesTool())
    expect(await call(t2, { userId: 'bob' })).toBe('status: error (not_authorized)\nerror: Not authorized to access that user\'s data.')
    expect(audit.records.map(r => r.outcome)).toEqual(['success', 'rate_limited'])
    expect(s2.audit.records[0]).toMatchObject({ outcome: 'authorized_reject', errorCode: 'not_authorized' })
  })

  it('no context: refused no_context', async () => {
    const { handle, audit } = setup()
    handle.setContext(null)
    const t = handle.add(seriesTool())
    expect(await call(t, { userId: 'alice' })).toBe('status: error (no_context)\nerror: Tool call failed: request context not set.')
    expect(audit.records[0]).toMatchObject({ outcome: 'error', errorCode: 'no_context' })
  })
})

describe('output check', () => {
  const bad = { ...seriesData(), avgValue: 'high' }

  it('at runtime (error_outcome): output_invalid to the model, paths only in the audit, onResult without the rejected data', async () => {
    const { handle, audit, events } = setup({ outputValidation: 'error_outcome' })
    const t = handle.add(seriesTool(() => outcome.ok(bad, { window: WINDOW, asOf: null })))
    const text = await call(t, { userId: 'alice' })
    expect(text).toBe(`status: error (output_invalid)\nerror: Tool call failed.\nnote: ${UNREADABLE_GUIDANCE}`)
    expect(audit.records[0]).toMatchObject({ outcome: 'error', resultStatus: 'error', errorCode: 'output_invalid' })
    expect(audit.records[0].errorMessage).toContain('data.avgValue: invalid_type (expected number)')
    // Never the value.
    expect(audit.records[0].errorMessage).not.toContain('high')
    expect(events[0].outcome.data).toBeNull()
    expect(events[0].outcome.error?.code).toBe('output_invalid')
  })

  it('under a test runner (the default here) it throws, after auditing the call', async () => {
    const { handle, audit } = setup()
    const t = handle.add(seriesTool(() => outcome.ok(bad, { window: WINDOW, asOf: null })))
    await expect(call(t, { userId: 'alice' })).rejects.toBeInstanceOf(ToolOutputError)
    expect(audit.records[0].errorCode).toBe('output_invalid')
  })

  it.each([
    ['ok without data', { ...okOutcome(), data: null }, 'data: required when status is ok'],
    ['insufficient without data', { ...okOutcome(), status: 'insufficient', data: null }, 'data: required when status is insufficient'],
    ['an error from the impl other than invalid_args', { ...outcome.invalid('x'), error: { code: 'rate_limited', message: 'x', retryable: true } }, 'error.code: an impl may return invalid_args only'],
    ['error with data', { ...outcome.invalid('x'), data: seriesData() }, 'data: must be null when status is error'],
    ['a window with an impossible date', { ...okOutcome(), window: { ...WINDOW, from: '2026-02-30' } }, 'window.from: not a YYYY-MM-DD date'],
    ['a window from after to', { ...okOutcome(), window: { ...WINDOW, from: '2026-11-22' } }, 'window: from is after to'],
    ['asOf not an instant', { ...okOutcome(), asOf: 'yesterday' }, 'asOf: not an ISO-8601 instant'],
    ['four guidance lines', { ...okOutcome(), guidance: ['a', 'b', 'c', 'd'] }, 'guidance: more than 3 items'],
    ['a long guidance line', { ...okOutcome(), guidance: ['x'.repeat(141)] }, 'guidance.0: longer than 140 chars'],
  ])('an envelope breach is output_invalid: %s', async (_case, o, problem) => {
    const { handle, audit } = setup({ outputValidation: 'error_outcome' })
    const t = handle.add(seriesTool(() => o))
    expect(await call(t, { userId: 'alice' })).toContain('status: error (output_invalid)')
    expect(audit.records[0].errorMessage).toContain(problem)
  })

  it('an impl\'s truncated is overwritten by the framework', async () => {
    const { handle, events } = setup()
    const t = handle.add(seriesTool(() => ({ ...okOutcome(), truncated: { path: 'items', droppedItems: 99, kept: 'newest', hardCut: true } })))
    const text = await call(t, { userId: 'alice' })
    expect(text).not.toContain('truncated')
    expect(events[0].outcome.truncated).toBeNull()
  })

  it('validated data is what renders: unknown keys are stripped, schema order kept', async () => {
    const { handle } = setup()
    const t = handle.add(seriesTool(() => outcome.ok({ secretKey: 'x', ...seriesData(1) }, { window: null, asOf: null })))
    const text = await call(t, { userId: 'alice' })
    expect(text).not.toContain('secretKey')
    expect(text.split('\n').slice(2, 5)).toEqual(['label: Steady', 'avgValue: 42.5', 'summary: daysWithData=1, daysExpected=1'])
  })
})

describe('copy guard over every string', () => {
  function guarded() {
    registerPack(definePack({
      name: 'guardtest',
      copyGuard: (text: string, source: string) => {
        if (/forbidden/i.test(text))
          throw new Error(`${source}: banned term "forbidden"`)
      },
    }))
  }

  it.each([
    ['a data leaf', () => outcome.ok({ ...seriesData(), label: 'Forbidden' }, { window: WINDOW, asOf: null })],
    ['a nested data leaf', () => outcome.ok({ ...seriesData(2), items: [{ ...seriesData(1).items[0], note: 'forbidden' }] }, { window: WINDOW, asOf: null })],
    ['guidance', () => outcome.ok(seriesData(), { window: WINDOW, asOf: null, guidance: ['Say forbidden.'] })],
    ['an impl error message', () => outcome.invalid('forbidden period')],
  ])('a breach in %s is copy_guard; the model never sees the text, the audit has the term', async (_case, result) => {
    guarded()
    const { handle, audit } = setup()
    const t = handle.add(seriesTool(result))
    const text = await call(t, { userId: 'alice' })
    expect(text).toBe(`status: error (copy_guard)\nerror: Tool call failed.\nnote: ${UNREADABLE_GUIDANCE}`)
    expect(text.toLowerCase()).not.toContain('forbidden')
    expect(audit.records[0]).toMatchObject({ outcome: 'error', errorCode: 'copy_guard', errorMessage: 'getSeries: banned term "forbidden"' })
  })

  it('a breach the renderer adds is caught on the rendered text', async () => {
    guarded()
    const { handle, audit } = setup({ render: { byTool: { getSeries: () => 'A forbidden sentence.' } } })
    const t = handle.add(seriesTool())
    const text = await call(t, { userId: 'alice' })
    expect(text).not.toContain('forbidden sentence')
    expect(audit.records[0].errorCode).toBe('copy_guard')
  })

  it('a renderer that throws is internal', async () => {
    const { handle, audit } = setup({
      render: {
        byTool: {
          getSeries: (o) => {
            if (o.status === 'ok')
              throw new TypeError('boom')
            return 'error'
          },
        },
      },
    })
    const t = handle.add(seriesTool())
    await call(t, { userId: 'alice' })
    expect(audit.records[0].errorCode).toBe('internal')
  })
})

describe('onResult', () => {
  it('a listener that throws is logged and never changes the model\'s result', async () => {
    const warn = vi.fn()
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }
    const { handle } = setup({ logger, onResult: () => { throw new Error('listener broke') } })
    const t = handle.add(seriesTool())
    expect(await call(t, { userId: 'alice' })).toContain('status: ok')
    expect(warn).toHaveBeenCalledWith('tool onResult listener threw', expect.objectContaining({ toolName: 'getSeries' }))
  })

  it('the outcome is a frozen copy: a listener cannot change what was audited or cached', async () => {
    const { handle, events } = setup()
    const t = handle.add(seriesTool())
    await call(t, { userId: 'alice' })
    const o = events[0].outcome as unknown as { data: { label: string } }
    expect(Object.isFrozen(o)).toBe(true)
    expect(Object.isFrozen(o.data)).toBe(true)
    expect(() => {
      o.data.label = 'changed'
    }).toThrow()
  })

  it('unsubscribe stops delivery; args include host-supplied ones', async () => {
    const { handle, events } = setup()
    const seen: unknown[] = []
    const off = handle.onResult(e => seen.push(e.args))
    const t = handle.add(seriesTool())
    await call(t, { userId: 'alice', period: 'this_week' })
    off()
    await call(t, { userId: 'alice', period: 'last_7_days' })
    expect(seen).toEqual([{ userId: 'alice', period: 'this_week' }])
    expect(events).toHaveLength(2)
  })

  it('the impl sees the turn and the clock', async () => {
    const { handle } = setup()
    const seen: unknown[] = []
    const t = handle.add({
      ...seriesTool(),
      impl: async (_input: unknown, c: { turn: unknown, now: () => Date }) => {
        seen.push([c.turn, c.now().toISOString()])
        return okOutcome()
      },
    } as never)
    const turn = handle.beginTurn({ id: 'answer-1' })
    await call(t, { userId: 'alice' })
    turn.end()
    expect(seen).toEqual([[{ id: 'answer-1', callIndex: 1 }, ctx.now!().toISOString()]])
  })
})
