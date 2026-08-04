/**
 * `getSpO2` formatter (Sprint 5 T-31, Ziva #2).
 *
 * The reference implementation for principle 37. The underlying data has a
 * field counting readings below 90% during sleep; the clinical word for
 * that is on the banned list, so this formatter has to say what happened
 * without reaching for it:
 *
 *   "A couple of brief low moments during sleep."
 *
 * not
 *
 *   "2 desaturation events. minSpo2=87."
 *
 * The second version is not just colder — it is the version the assistant
 * repeats back to the user, which is how clinical vocabulary leaks into a
 * consumer wellness product.
 */

import type { SpO2BaselineRow, SpO2NightRow } from '../impls/spo2'
import { assertNoBanTerms } from './copy-guidelines'

const FORMATTER_NAME = 'getSpO2'

/**
 * Small counts read better as words, and vague is honest here — the exact
 * count of dips is not a number the user should be doing arithmetic on.
 */
function describeLowMoments(count: number): string {
  if (count === 0) return 'No brief low moments'
  if (count === 1) return 'One brief low moment'
  if (count === 2) return 'A couple of brief low moments'
  if (count <= 5) return 'A few brief low moments'
  return 'Several brief low moments'
}

/** "in your usual range" needs a usual range to compare against. */
function describeRange(
  avg: number,
  baseline: SpO2BaselineRow | null,
): string {
  if (!baseline) {
    // Below 20 days of data. Saying nothing is better than implying a
    // reference range we do not have.
    return 'Still learning your usual range.'
  }
  const lo = Math.round(baseline.p10)
  const hi = Math.round(baseline.p50 + (baseline.p50 - baseline.p10))
  const within = avg >= baseline.p10
  return within
    ? `Overall in your usual range (typically ${lo}–${hi}%).`
    : `A little below your usual range (typically ${lo}–${hi}%).`
}

export function formatSpO2(
  nights: readonly SpO2NightRow[],
  baseline: SpO2BaselineRow | null,
  days: number,
): string {
  if (nights.length === 0) {
    const empty = days === 1
      ? 'No sleep readings for last night yet.'
      : `No sleep readings in the last ${days} days yet.`
    assertNoBanTerms(empty, FORMATTER_NAME)
    return empty
  }

  const latest = nights[nights.length - 1]
  const lines: string[] = []

  if (nights.length === 1) {
    lines.push('Last night:')
  }
  else {
    lines.push(`Last ${nights.length} nights:`)
  }

  lines.push(
    `  Average oxygen: ${Math.round(latest.avg_spo2)}%. `
    + `${describeLowMoments(latest.low_moment_count)} during sleep.`,
  )

  if (nights.length > 1) {
    const avgAll
      = nights.reduce((a, n) => a + n.avg_spo2, 0) / nights.length
    lines.push(`  Across those nights: ${Math.round(avgAll)}% on average.`)
  }

  lines.push(`  ${describeRange(latest.avg_spo2, baseline)}`)

  const text = lines.join('\n')
  // Runtime guard, not just a test: a future edit that interpolates a
  // clinical phrase fails the tool call rather than teaching the model.
  assertNoBanTerms(text, FORMATTER_NAME)
  return text
}
