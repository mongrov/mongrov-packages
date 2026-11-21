/**
 * Output budget enforcement for tool results.
 *
 * `applyOutputBudget` trims `ToolResult.text` when its UTF-8 byte size
 * exceeds `budget.maxBytes`.
 *
 * Rows go first, OLDEST first. A tool lists dated rows (`  2026-11-20: ...`)
 * between a header line and summary lines; cutting from the end, as this
 * did before, dropped the newest rows and the summary, which are what a
 * question about "how am I doing" needs most. So dated rows are removed in
 * date order, earliest first, and one marker line stands where they were;
 * every undated line (header, summary) is kept. Rows may be in either order.
 * Only when the text still does not fit with every dated row gone is it cut
 * at a UTF-8-safe byte boundary with a `\n[truncated]` suffix, as before.
 *
 * `budget.maxRows` is informational — tool impls limit row count
 * via SQL LIMIT. `rowCount` is passed through unchanged.
 */

import type { OutputBudget, ToolResult } from './types'

const TRUNCATE_SUFFIX = '\n[truncated]'

/**
 * A row line: optional indent, an optional `[tag]`, then an ISO date (and
 * optionally a time). The captured date-time orders the rows.
 */
const ROW_RE = /^\s*(?:\[[^\]\n]*\]\s*)?(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)/
const INDENT_RE = /^\s*/

/**
 * Drop dated rows, oldest first, until `fits(text)`. Returns the text with
 * `marker(n)` (indented like the first row it replaces) standing in for the
 * `n` dropped rows, or `null` when even dropping every dated row does not
 * fit (or the text has none). Generic: used by the package budget and by a
 * host's own, smaller cap.
 */
export function trimOldestRows(
  text: string,
  fits: (candidate: string) => boolean,
  marker: (dropped: number) => string,
): string | null {
  const lines = text.split('\n')
  const rows: { index: number, key: string }[] = []
  lines.forEach((line, index) => {
    const m = ROW_RE.exec(line)
    if (m)
      rows.push({ index, key: m[1] })
  })
  if (rows.length === 0)
    return null
  // Earliest first; a stable sort keeps document order for equal keys.
  const order = [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))

  const render = (dropped: ReadonlySet<number>): string => {
    const out: string[] = []
    let placed = false
    lines.forEach((line, index) => {
      if (!dropped.has(index)) {
        out.push(line)
        return
      }
      if (!placed) {
        placed = true
        const indent = INDENT_RE.exec(line)?.[0] ?? ''
        out.push(`${indent}${marker(dropped.size)}`)
      }
    })
    return out.join('\n')
  }

  const dropped = new Set<number>()
  for (const row of order) {
    dropped.add(row.index)
    const candidate = render(dropped)
    if (fits(candidate))
      return candidate
  }
  return null
}

export function applyOutputBudget(
  result: ToolResult,
  budget: OutputBudget,
): ToolResult {
  if (result.bytes <= budget.maxBytes)
    return result

  const encoder = new TextEncoder()
  const byteLength = (t: string): number => encoder.encode(t).byteLength

  const trimmed = trimOldestRows(
    result.text,
    t => byteLength(t) <= budget.maxBytes,
    n => `[truncated: ${n} earlier ${n === 1 ? 'row' : 'rows'} left out]`,
  )
  if (trimmed !== null)
    return { text: trimmed, rowCount: result.rowCount, bytes: byteLength(trimmed) }

  const suffixBytes = encoder.encode(TRUNCATE_SUFFIX).byteLength
  const targetBytes = Math.max(0, budget.maxBytes - suffixBytes)

  const encoded = encoder.encode(result.text)
  const safeEnd = utf8SafeBoundary(encoded, Math.min(targetBytes, encoded.byteLength))
  const decoded = new TextDecoder('utf-8').decode(encoded.slice(0, safeEnd))
  const truncated = `${decoded}${TRUNCATE_SUFFIX}`

  return {
    text: truncated,
    rowCount: result.rowCount,
    bytes: byteLength(truncated),
  }
}

/**
 * Walk `end` backward until it points to a valid UTF-8 codepoint
 * boundary — i.e. either past-the-end of the array or at a byte
 * whose top bits are not `10` (continuation). This guarantees that
 * `bytes.slice(0, boundary)` decodes without emitting replacement
 * characters for a partial trailing multibyte sequence.
 */
function utf8SafeBoundary(bytes: Uint8Array, end: number): number {
  let boundary = end
  // A continuation byte matches 10xxxxxx (0x80..0xBF).
  while (boundary > 0 && (bytes[boundary] & 0xC0) === 0x80) {
    boundary -= 1
  }
  // If boundary now points to a lead byte (top bit set), check
  // whether the full sequence fits inside `end`. If not, drop the
  // lead byte as well.
  if (boundary > 0 && boundary < bytes.byteLength) {
    const lead = bytes[boundary]
    let seqLen = 0
    if ((lead & 0x80) === 0x00)
      seqLen = 1
    else if ((lead & 0xE0) === 0xC0)
      seqLen = 2
    else if ((lead & 0xF0) === 0xE0)
      seqLen = 3
    else if ((lead & 0xF8) === 0xF0)
      seqLen = 4
    if (seqLen > 1 && boundary + seqLen > end) {
      // Partial sequence — drop lead byte.
      return boundary
    }
  }
  return boundary
}
