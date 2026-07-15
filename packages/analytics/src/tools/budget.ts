/**
 * Output budget enforcement for tool results.
 *
 * `applyOutputBudget` truncates `ToolResult.text` when its UTF-8
 * byte size exceeds `budget.maxBytes`, appending a `\n[truncated]`
 * suffix. Truncation is UTF-8-safe: bytes are sliced and re-decoded
 * with `fatal: false` so any partial multi-byte codepoint at the
 * boundary is dropped rather than emitting invalid sequences.
 *
 * `budget.maxRows` is informational — tool impls limit row count
 * via SQL LIMIT. This helper does not attempt row-level truncation.
 */

import type { OutputBudget, ToolResult } from './types'

const TRUNCATE_SUFFIX = '\n[truncated]'

export function applyOutputBudget(
  result: ToolResult,
  budget: OutputBudget,
): ToolResult {
  if (result.bytes <= budget.maxBytes) return result

  const encoder = new TextEncoder()
  const suffixBytes = encoder.encode(TRUNCATE_SUFFIX).byteLength
  const targetBytes = Math.max(0, budget.maxBytes - suffixBytes)

  const encoded = encoder.encode(result.text)
  const safeEnd = utf8SafeBoundary(encoded, Math.min(targetBytes, encoded.byteLength))
  const decoded = new TextDecoder('utf-8').decode(encoded.slice(0, safeEnd))
  const truncated = `${decoded}${TRUNCATE_SUFFIX}`

  return {
    text: truncated,
    rowCount: result.rowCount,
    bytes: encoder.encode(truncated).byteLength,
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
    if ((lead & 0x80) === 0x00) seqLen = 1
    else if ((lead & 0xE0) === 0xC0) seqLen = 2
    else if ((lead & 0xF0) === 0xE0) seqLen = 3
    else if ((lead & 0xF8) === 0xF0) seqLen = 4
    if (seqLen > 1 && boundary + seqLen > end) {
      // Partial sequence — drop lead byte.
      return boundary
    }
  }
  return boundary
}
