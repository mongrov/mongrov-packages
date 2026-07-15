import { describe, expect, it } from 'vitest'
import { applyOutputBudget } from '../budget'
import type { ToolResult } from '../types'

function makeResult(text: string, rowCount = 1): ToolResult {
  return {
    text,
    rowCount,
    bytes: new TextEncoder().encode(text).byteLength,
  }
}

describe('applyOutputBudget', () => {
  it('returns unchanged when under budget', () => {
    const r = makeResult('hello')
    const out = applyOutputBudget(r, { maxBytes: 100, maxRows: 100 })
    expect(out).toBe(r)
  })

  it('returns unchanged when exactly at budget', () => {
    const text = 'x'.repeat(100)
    const r = makeResult(text)
    const out = applyOutputBudget(r, { maxBytes: 100, maxRows: 100 })
    expect(out.text).toBe(text)
    expect(out.bytes).toBe(100)
  })

  it('truncates ASCII text over budget with suffix', () => {
    const text = 'x'.repeat(200)
    const r = makeResult(text)
    const out = applyOutputBudget(r, { maxBytes: 50, maxRows: 100 })
    expect(out.text.endsWith('\n[truncated]')).toBe(true)
    expect(out.bytes).toBeLessThanOrEqual(50)
    expect(out.rowCount).toBe(1)
  })

  it('truncates UTF-8 multibyte text without producing invalid sequences', () => {
    // Each emoji is 4 bytes in UTF-8. String of 50 emoji = 200 bytes.
    const text = '🚀'.repeat(50)
    const r = makeResult(text)
    const out = applyOutputBudget(r, { maxBytes: 30, maxRows: 100 })
    expect(out.text.endsWith('\n[truncated]')).toBe(true)
    expect(out.bytes).toBeLessThanOrEqual(30)
    // Confirm decoded text has no lone surrogates: encoding + decoding
    // round-trips byte-for-byte.
    const roundTripped = new TextDecoder().decode(new TextEncoder().encode(out.text))
    expect(roundTripped).toBe(out.text)
  })

  it('produces empty prefix when budget is smaller than suffix', () => {
    const text = 'x'.repeat(100)
    const r = makeResult(text)
    const out = applyOutputBudget(r, { maxBytes: 5, maxRows: 100 })
    // Budget < suffix length: prefix drops to 0, output is just the
    // suffix. bytes still exceeds maxBytes because suffix is longer
    // than budget — this is the documented degenerate case.
    expect(out.text).toBe('\n[truncated]')
  })

  it('preserves rowCount from input', () => {
    const r = makeResult('x'.repeat(200), 42)
    const out = applyOutputBudget(r, { maxBytes: 50, maxRows: 100 })
    expect(out.rowCount).toBe(42)
  })

  it('recomputes bytes from truncated text', () => {
    const r = makeResult('x'.repeat(200))
    const out = applyOutputBudget(r, { maxBytes: 50, maxRows: 100 })
    expect(out.bytes).toBe(new TextEncoder().encode(out.text).byteLength)
  })
})
