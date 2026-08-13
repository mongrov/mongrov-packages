import type { ToolContext } from '../types'
import { generateText } from 'ai'
import { MockLanguageModelV1 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeEngine } from '../__fakes__/engine'
import { createAnalyticsTools } from '../factory'

/**
 * T-15 — Full AI SDK loop.
 *
 * Wires the analytics tools handle into `generateText` against a
 * `MockLanguageModelV1` whose `doGenerate` is sequenced with
 * `vi.fn().mockResolvedValueOnce(...)`, so the model first emits
 * tool-calls (finishReason: 'tool-calls'), the SDK dispatches into
 * the wrapped `tool.execute`, then re-invokes the model with the
 * tool result and receives the final text.
 *
 * Together with the factory/wrap unit tests this proves the whole
 * chain — model → SDK → wrapper (rate → auth → execute → budget →
 * audit) → model → text — behaves end-to-end.
 */

const baseCtx: ToolContext = {
  requesterUserId: 'alice',
  brand: 'zivaone',
  familyId: 'fam-1',
}

// Helper: build a rawCall block satisfying the LanguageModelV1 contract
// without leaking test-only shape into the assertions below.
function rawCall() {
  return { rawPrompt: null, rawSettings: {} } as const
}

function usage() {
  return { promptTokens: 10, completionTokens: 5 }
}

describe('generateText loop against analytics tools handle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('single-tool loop: model → getHRV → model produces final text', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM v_hrv', [
      { day: '2026-07-10', avg_hrv: 42.5 },
      { day: '2026-07-11', avg_hrv: 44.0 },
    ])
    const handle = createAnalyticsTools({
      analytics: engine,
      rateLimit: false,
      audit: { batchSize: 1 },
    })
    handle.setContext(baseCtx)

    const doGenerate = vi
      .fn<Parameters<MockLanguageModelV1['doGenerate']>, ReturnType<MockLanguageModelV1['doGenerate']>>()
      // Step 1: model emits a tool-call for getHRV.
      .mockResolvedValueOnce({
        finishReason: 'tool-calls',
        usage: usage(),
        rawCall: rawCall(),
        toolCalls: [
          {
            toolCallType: 'function',
            toolCallId: 'call-hrv-1',
            toolName: 'getHRV',
            args: JSON.stringify({ userId: 'alice', days: 7 }),
          },
        ],
      })
      // Step 2: model, given the tool result, produces final text.
      .mockResolvedValueOnce({
        finishReason: 'stop',
        usage: usage(),
        rawCall: rawCall(),
        text: 'Your HRV trend looks good.',
      })

    const model = new MockLanguageModelV1({ doGenerate })

    const result = await generateText({
      model,
      tools: handle.tools,
      maxSteps: 3,
      prompt: 'How is my HRV?',
    })

    expect(result.text).toBe('Your HRV trend looks good.')
    expect(result.steps).toHaveLength(2)
    // Step 1 dispatched the tool; step 2 emitted the final text.
    expect(result.steps[0].toolCalls).toHaveLength(1)
    expect(result.steps[0].toolCalls[0].toolName).toBe('getHRV')
    expect(result.steps[0].toolResults).toHaveLength(1)
    expect(String(result.steps[0].toolResults[0].result)).toContain('HRV')

    // Wrapper actually ran the HRV query against the fake engine.
    const hrvCalls = engine.calls.filter(c => c.sql.includes('FROM v_hrv'))
    expect(hrvCalls).toHaveLength(1)

    // Audit row written (batchSize: 1 flushes eagerly).
    await vi.waitFor(() => {
      const auditCalls = engine.calls.filter(c =>
        c.sql.includes('INSERT INTO tool_call_audit'),
      )
      expect(auditCalls).toHaveLength(1)
      expect(auditCalls[0].params.p0_tool_name).toBe('getHRV')
      expect(auditCalls[0].params.p0_outcome).toBe('success')
    })

    await handle.close()
  })

  it('multi-tool chain: getHRV then compareTrend then final text; both audit rows written in order', async () => {
    const engine = createFakeEngine()
    // getHRV query.
    engine.queueRows('FROM v_hrv', [
      { day: '2026-07-10', avg_hrv: 42.5 },
      { day: '2026-07-11', avg_hrv: 44.0 },
    ])
    // compareTrend runs two HRV window queries; enqueue both.
    engine.queueRows('FROM v_hrv', [{ day: '2026-07-01', avg_hrv: 40 }])
    engine.queueRows('FROM v_hrv', [{ day: '2026-07-10', avg_hrv: 45 }])

    const handle = createAnalyticsTools({
      analytics: engine,
      rateLimit: false,
      audit: { batchSize: 1 },
    })
    handle.setContext(baseCtx)

    const doGenerate = vi
      .fn<Parameters<MockLanguageModelV1['doGenerate']>, ReturnType<MockLanguageModelV1['doGenerate']>>()
      .mockResolvedValueOnce({
        finishReason: 'tool-calls',
        usage: usage(),
        rawCall: rawCall(),
        toolCalls: [
          {
            toolCallType: 'function',
            toolCallId: 'call-hrv',
            toolName: 'getHRV',
            args: JSON.stringify({ userId: 'alice', days: 7 }),
          },
        ],
      })
      .mockResolvedValueOnce({
        finishReason: 'tool-calls',
        usage: usage(),
        rawCall: rawCall(),
        toolCalls: [
          {
            toolCallType: 'function',
            toolCallId: 'call-cmp',
            toolName: 'compareTrend',
            args: JSON.stringify({
              userId: 'alice',
              metric: 'hrv_ms',
              currentWindowDays: 7,
              priorWindowDays: 7,
            }),
          },
        ],
      })
      .mockResolvedValueOnce({
        finishReason: 'stop',
        usage: usage(),
        rawCall: rawCall(),
        text: 'HRV is trending up week over week.',
      })

    const model = new MockLanguageModelV1({ doGenerate })

    const result = await generateText({
      model,
      tools: handle.tools,
      maxSteps: 5,
      prompt: 'How is my HRV trending?',
    })

    expect(result.text).toBe('HRV is trending up week over week.')
    expect(result.steps).toHaveLength(3)
    expect(result.steps[0].toolCalls[0].toolName).toBe('getHRV')
    expect(result.steps[1].toolCalls[0].toolName).toBe('compareTrend')

    // Two audit rows in dispatch order.
    await vi.waitFor(() => {
      const auditCalls = engine.calls.filter(c =>
        c.sql.includes('INSERT INTO tool_call_audit'),
      )
      expect(auditCalls).toHaveLength(2)
      expect(auditCalls[0].params.p0_tool_name).toBe('getHRV')
      expect(auditCalls[0].params.p0_outcome).toBe('success')
      expect(auditCalls[1].params.p0_tool_name).toBe('compareTrend')
      expect(auditCalls[1].params.p0_outcome).toBe('success')
    })

    await handle.close()
  })

  it('wrapper reject surfaces to model as tool result; loop continues; audit records authorized_reject', async () => {
    const engine = createFakeEngine()
    // If the wrapper accidentally executed we would leak this row; test
    // asserts no HRV SELECT happened.
    engine.queueRows('FROM v_hrv', [{ day: '2026-07-10', avg_hrv: 99 }])

    const authorize = vi.fn(async () => false)
    const handle = createAnalyticsTools({
      analytics: engine,
      rateLimit: false,
      audit: { batchSize: 1 },
      authorize,
    })
    handle.setContext(baseCtx)

    const doGenerate = vi
      .fn<Parameters<MockLanguageModelV1['doGenerate']>, ReturnType<MockLanguageModelV1['doGenerate']>>()
      .mockResolvedValueOnce({
        finishReason: 'tool-calls',
        usage: usage(),
        rawCall: rawCall(),
        toolCalls: [
          {
            toolCallType: 'function',
            toolCallId: 'call-hrv-bob',
            toolName: 'getHRV',
            // Requesting another user's data → authorize returns false.
            args: JSON.stringify({ userId: 'bob', days: 7 }),
          },
        ],
      })
      .mockResolvedValueOnce({
        finishReason: 'stop',
        usage: usage(),
        rawCall: rawCall(),
        text: 'I could not read that data.',
      })

    const model = new MockLanguageModelV1({ doGenerate })

    const result = await generateText({
      model,
      tools: handle.tools,
      maxSteps: 3,
      prompt: 'How is bob\'s HRV?',
    })

    // Model got a chance to respond after the reject.
    expect(result.text).toBe('I could not read that data.')
    expect(result.steps).toHaveLength(2)
    // Tool result surfaced as a plain string containing the reject sentinel.
    const toolResult = String(result.steps[0].toolResults[0].result)
    expect(toolResult).toContain('Not authorized')

    // No HRV SELECT ran (authorize rejected before execute).
    const hrvSelects = engine.calls.filter(
      c => c.sql.includes('FROM hrv') && !c.sql.includes('INSERT'),
    )
    expect(hrvSelects).toHaveLength(0)

    // Audit records the reject.
    await vi.waitFor(() => {
      const auditCalls = engine.calls.filter(c =>
        c.sql.includes('INSERT INTO tool_call_audit'),
      )
      expect(auditCalls).toHaveLength(1)
      expect(auditCalls[0].params.p0_tool_name).toBe('getHRV')
      expect(auditCalls[0].params.p0_outcome).toBe('authorized_reject')
    })

    await handle.close()
  })
})
