/**
 * Shared string helpers for tool output formatting.
 *
 * No I/O; safe to import from any impl. Used to compute the `bytes`
 * field of `ToolResult` and to render deltas consistently across
 * tools.
 */

export function formatBytes(s: string): number {
  return new TextEncoder().encode(s).byteLength
}

/**
 * Format a signed percentage delta between two numbers. Returns `n/a`
 * when the prior baseline is zero (avoids Infinity / NaN in tool
 * output).
 */
export function deltaPct(current: number, prior: number): string {
  if (prior === 0) return 'n/a'
  const pct = ((current - prior) / prior) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

/** Population stddev; returns 0 when the sample is empty. */
export function popStddev(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((a, v) => a + v, 0) / values.length
  const variance
    = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}
