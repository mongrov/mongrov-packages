/**
 * `settle_min` and `recovered_min` — the two per-night scalars the port adds
 * to v3.1 (sleep-correction spec; registry §2.6; ruling R-C).
 *
 * settle_min: minutes from bed (the first primary minute) until the first HR
 * sample at or below `night_min × 1.05` after which HR stays at or below that
 * level for 15 minutes. `night_min` is the lowest HR inside the primary block.
 * Null when it never settles, when there is no primary block, and — R-C — when
 * the HR tier is coarser than 10 min: a 30-min cadence cannot support a
 * minutes-resolution claim.
 *
 * Two readings of "stays for 15 minutes" the registry leaves open, decided
 * here conservatively: every sample in [t, t + 15 min] must be at or below the
 * level, and the data must actually reach t + 15 min — a run cut off by the end
 * of the block is unconfirmed, not settled.
 */

import type { ClassifiedRow, VitalSample } from './classify'

import { parseDateStr } from './classify'

export const SETTLE_HR_FACTOR = 1.05
export const SETTLE_SUSTAIN_SEC = 900
export const SETTLE_MAX_TIER_MIN = 10

export function computeSettleMin(
  rows: ClassifiedRow[],
  vitals: VitalSample[],
  hrIntervalMin: number,
): number | null {
  if (hrIntervalMin > SETTLE_MAX_TIER_MIN)
    return null
  const primary = rows.filter(r => r.block_type === 'primary').map(r => parseDateStr(r.date))
  if (!primary.length)
    return null
  const bed = Math.min(...primary)
  const end = Math.max(...primary)

  const hr = vitals
    .filter(v => v.kind === 'hr' && Number.isFinite(v.value) && v.value > 0 && v.epoch >= bed && v.epoch <= end)
    .map(v => ({ e: v.epoch, v: v.value }))
    .sort((a, b) => a.e - b.e)
  if (!hr.length)
    return null

  const level = Math.min(...hr.map(h => h.v)) * SETTLE_HR_FACTOR
  const last = hr[hr.length - 1].e
  for (let i = 0; i < hr.length; i++) {
    if (hr[i].v > level)
      continue
    const until = hr[i].e + SETTLE_SUSTAIN_SEC
    if (last < until)
      return null // not enough data left to confirm any later run either
    let held = true
    for (let j = i; j < hr.length && hr[j].e <= until; j++) {
      if (hr[j].v > level) {
        held = false
        break
      }
    }
    if (held)
      return Math.round((hr[i].e - bed) / 60)
  }
  return null
}

/** Primary minutes that came from HR recovery (envelope/gap), not firmware. */
export function recoveredMinutes(rows: ClassifiedRow[]): number {
  return rows.filter(r => r.block_type === 'primary' && (r.source === 'envelope' || r.source === 'gap')).length
}
