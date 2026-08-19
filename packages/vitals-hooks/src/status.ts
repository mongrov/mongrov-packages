/**
 * A2 — the status resolver.
 *
 * "You never decide which state applies — the hook does." This is that
 * decision, extracted as a pure function because every hook needs it and
 * because it is the piece most likely to drift between vitals if each one
 * re-implements the ladder.
 *
 * The contract states the rules directly:
 *
 *   cadence row missing        → 'no-sensor'
 *   daysWorn == 0              → 'first-day'
 *   baseline.sample_count < 30 → 'learning'
 *   otherwise                  → 'ready'
 *
 * ORDER MATTERS and is not alphabetical or arbitrary. A ring without the
 * sensor also has `daysWorn == 0` and no baseline, so `no-sensor` must be
 * tested first or every sensorless ring reads as a first-day user and gets a
 * checklist telling them to wear it overnight. Likewise a day-1 user has
 * `sample_count < 30`, so `first-day` must precede `learning` or they get a
 * chart with no data in it instead of the first-run steps.
 *
 * Each rung subsumes the ones below it; the ladder only reads correctly
 * top-down.
 */

import type { VitalStatus } from './types'

export interface StatusInputs {
  /** Still fetching the first paint. Outranks everything — we know nothing. */
  isLoading: boolean
  /**
   * Whether the device reports a cadence row for this metric. `false` means
   * the ring lacks the sensor, which is a different thing from having it and
   * never having worn it.
   */
  hasCadence: boolean
  /** Distinct days with at least one reading. */
  daysWorn: number
  /**
   * Days behind the stored baseline. `null` when no baseline row exists yet,
   * which is the same as zero for this decision but is worth distinguishing
   * at the call site.
   */
  baselineSampleCount: number | null
}

/** The Day-30 gate. Not a magic number at the call sites. */
export const BASELINE_READY_DAYS = 30

export function resolveVitalStatus(inputs: StatusInputs): VitalStatus {
  const { isLoading, hasCadence, daysWorn, baselineSampleCount } = inputs

  // First paint only. Anything below would be guessing from absent data —
  // in particular, an empty result during load looks exactly like a ring
  // that has never been worn.
  if (isLoading)
    return 'loading'

  // Before daysWorn: a ring without the sensor also has zero days.
  if (!hasCadence)
    return 'no-sensor'

  // Before the baseline check: a day-1 user also has an immature baseline,
  // and the first-run checklist is the more useful screen.
  if (daysWorn === 0)
    return 'first-day'

  if ((baselineSampleCount ?? 0) < BASELINE_READY_DAYS)
    return 'learning'

  return 'ready'
}

/**
 * Whether this status renders the vital's data at all.
 *
 * `learning` is the reason this is not simply `status === 'ready'`: it renders
 * the chart, but without verdicts. Screens branch on the status itself; this
 * exists for the hooks, which need to know whether to build a view or return
 * the empty shell.
 */
export function rendersData(status: VitalStatus): boolean {
  return status === 'ready' || status === 'learning'
}

/**
 * Whether the hook may return a verdict.
 *
 * Only `ready`. A2 is explicit that `learning` returns NO verdicts and
 * population rails only — the user has not earned a personal comparison yet,
 * and showing one built on 12 days would be inventing a baseline.
 */
export function allowsVerdict(status: VitalStatus): boolean {
  return status === 'ready'
}
