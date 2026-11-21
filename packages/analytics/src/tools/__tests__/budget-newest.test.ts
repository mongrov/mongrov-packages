/**
 * The budget keeps the NEWEST rows and every summary line.
 *
 * Tools list dated rows oldest first under a header, with summary lines
 * last. Cutting from the end dropped the newest rows and the summary first,
 * which is what a "how have I been lately" question needs most.
 */

import type { ToolResult } from '../types'
import { describe, expect, it } from 'vitest'
import { applyOutputBudget, trimOldestRows } from '../budget'

function result(text: string, rowCount = 1): ToolResult {
  return { text, rowCount, bytes: new TextEncoder().encode(text).byteLength }
}

/** `n` daily rows from 2026-08-01, oldest first, then a summary line. */
function series(n: number): string {
  const rows = Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10)
    return `  ${d}: ${(40 + (i % 9)).toFixed(1)}u`
  })
  return [`Series, last ${n} days:`, ...rows, `  ${n}-day avg: 44.0u (latest 48.0u, +9.1% vs avg)`].join('\n')
}

describe('applyOutputBudget keeps the newest rows', () => {
  it('drops the oldest rows, keeps header, newest rows and summary, and stays in budget', () => {
    const text = series(90)
    const out = applyOutputBudget(result(text, 90), { maxBytes: 600, maxRows: 100 })
    const lines = out.text.split('\n')

    expect(out.bytes).toBeLessThanOrEqual(600)
    expect(out.bytes).toBe(new TextEncoder().encode(out.text).byteLength)
    expect(lines[0]).toBe('Series, last 90 days:')
    expect(lines[1]).toMatch(/^ {2}\[truncated: \d+ earlier rows left out\]$/)
    // The newest day and the summary are both there.
    expect(lines.at(-2)).toBe('  2026-10-29: 48.0u')
    expect(lines.at(-1)).toBe('  90-day avg: 44.0u (latest 48.0u, +9.1% vs avg)')
    // What is kept is a contiguous newest run, and the marker counts the rest.
    const kept = lines.filter(l => /^ {2}\d{4}-/.test(l))
    const dropped = Number(/(\d+) earlier/.exec(lines[1])![1])
    expect(kept.length + dropped).toBe(90)
    expect(kept[0] > '  2026-08-01').toBe(true)
    expect(out.rowCount).toBe(90)
  })

  it('drops by date, not position: rows listed newest first lose their tail', () => {
    const text = [
      'Notices, last 30 days:',
      '  [warn] 2026-11-19 08:42:00: newest — body',
      '  [info] 2026-11-10 06:00:00: middle — body',
      '  [info] 2026-11-01 06:00:00: oldest — body',
    ].join('\n')
    const fits = (t: string) => t.length <= text.length - 10
    const out = trimOldestRows(text, fits, n => `(${n} left out)`)
    expect(out).toBe([
      'Notices, last 30 days:',
      '  [warn] 2026-11-19 08:42:00: newest — body',
      '  [info] 2026-11-10 06:00:00: middle — body',
      '  (1 left out)',
    ].join('\n'))
  })

  it('keeps undated lines between rows (a baseline line, a usual-range line)', () => {
    const text = [
      'Outliers (last 30d):',
      '  mean 45.1u, spread 6.2u',
      '  2026-11-03: 28.0u',
      '  2026-11-04: 29.0u',
      '  2026-11-20: 60.0u',
      '  usual: 40–50',
    ].join('\n')
    const out = trimOldestRows(text, t => t.split('\n').length <= 5, n => `[${n} earlier]`)
    expect(out).toBe([
      'Outliers (last 30d):',
      '  mean 45.1u, spread 6.2u',
      '  [2 earlier]',
      '  2026-11-20: 60.0u',
      '  usual: 40–50',
    ].join('\n'))
  })

  it('falls back to the byte cut when there are no dated rows', () => {
    const out = applyOutputBudget(result('x'.repeat(200)), { maxBytes: 50, maxRows: 100 })
    expect(out.text.endsWith('\n[truncated]')).toBe(true)
    expect(out.bytes).toBeLessThanOrEqual(50)
  })

  it('falls back to the byte cut when even no rows would not fit', () => {
    const text = `${'h'.repeat(100)}\n  2026-08-01: 1u\n${'s'.repeat(100)}`
    const out = applyOutputBudget(result(text), { maxBytes: 60, maxRows: 100 })
    expect(out.text.endsWith('\n[truncated]')).toBe(true)
  })
})
