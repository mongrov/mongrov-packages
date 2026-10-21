/**
 * Correct every night a sync touched — v3.1's post-sync loop, per night.
 *
 * As v3.1: the HR tier and sleeping-HR percentiles are computed once per run,
 * then each night gets its window, Phase 2 + 3, and the port's two scalars.
 * Unlike v3.1, each night's window uses the offset its own zone had at its
 * 18:00 (see `night.ts`), not one fixed device offset.
 *
 * A night that throws is reported `failed` and the rest continue — the spec's
 * containment rule: a failed night keeps whatever rows it already had; it
 * never blocks the batch. Writing the results (night-scoped replace) is the
 * caller's job (sleep-correction tasks §3).
 */

import type { ClassifiedRow } from './classify'
import type { SqlRunner } from './correct'
import type { SleepRelations } from './sql'
import type { StagingBounds } from './staging'

import { describeError } from '../../core/errors'
import { correctNight, detectHrTier, globalBaselines } from './correct'
import { nightWindow, offsetAtInstantMs } from './night'
import { computeSettleMin, recoveredMinutes } from './settle'

export interface CorrectSleepInput {
  /** 'YYYY-MM-DD' nights (6pm → 6pm), e.g. from `nightsForEpochs`. */
  nights: string[]
  /** The user's IANA zone. */
  timeZone: string
  /** Baseline lookback start (epoch seconds) — production: now − 30 d. */
  cutoffEpoch: number
  relations?: SleepRelations
}

export interface NightOutcome {
  night: string
  windowStart: number
  windowEnd: number
  tzOffsetHours: number
  status: 'ok' | 'no_firmware_sleep' | 'no_phase2_rows' | 'failed'
  rows?: ClassifiedRow[]
  settleMin?: number | null
  recoveredMin?: number
  error?: string
}

export interface CorrectSleepResult {
  hrIntervalMin: number
  p75: number
  p90: number
  nights: NightOutcome[]
}

export async function correctSleepNights(db: SqlRunner, input: CorrectSleepInput): Promise<CorrectSleepResult> {
  const hrIntervalMin = await detectHrTier(db, input.relations)
  const { p75, p90 } = await globalBaselines(db, input.cutoffEpoch, input.relations)

  const nights: NightOutcome[] = []
  for (const night of input.nights) {
    const w = nightWindow(night, input.timeZone)
    try {
      const res = await correctNight(db, { ...w, hrIntervalMin, p75, p90, relations: input.relations })
      if (res.status !== 'ok') {
        nights.push({ night, ...w, status: res.status })
        continue
      }
      nights.push({
        night,
        ...w,
        status: 'ok',
        rows: res.rows,
        settleMin: computeSettleMin(res.rows, res.vitals, hrIntervalMin),
        recoveredMin: recoveredMinutes(res.rows),
      })
    }
    catch (e) {
      // Recorded on the outcome; the deriver logs the failed nights.
      nights.push({ night, ...w, status: 'failed', error: describeError(e) })
    }
  }
  return { hrIntervalMin, p75, p90, nights }
}

/**
 * The staging bounds a `correctSleepNights` run over these nights needs
 * (see `StagingBounds`): the earliest `date` each relation is read at.
 *
 *   sleep     the earliest night window (`hasSleepDataSql`, Phase 2), and
 *             `cutoff - 30` (the baseline join's ±30 s)
 *   activity  the earliest night window (`morningVitalsSql`)
 *
 * No nights ⇒ no activity read, but the bound is left off rather than
 * guessed; the baselines still read sleep from the cutoff.
 */
export function stagingBoundsFor(input: Pick<CorrectSleepInput, 'nights' | 'timeZone' | 'cutoffEpoch'>): StagingBounds {
  const starts = input.nights.map(n => nightWindow(n, input.timeZone).windowStart)
  const firstWindow = starts.length > 0 ? Math.min(...starts) : undefined
  const sleepFromEpoch = Math.min(input.cutoffEpoch - 30, firstWindow ?? Number.POSITIVE_INFINITY)
  return { sleepFromEpoch, activityFromEpoch: firstWindow }
}

/**
 * The nights (6pm → 6pm local) that a set of instants falls in — which nights
 * a sync batch touched. Same attribution as v3.1's harness `nightOf`: shift to
 * local time, add 6 h so 18:00 lands on midnight, take the date.
 */
export function nightsForEpochs(epochs: Iterable<number>, timeZone: string): string[] {
  const out = new Set<string>()
  for (const e of epochs) {
    const offsetMs = offsetAtInstantMs(timeZone, e * 1000)
    out.add(new Date(e * 1000 + offsetMs + 6 * 3_600_000).toISOString().slice(0, 10))
  }
  return [...out].sort()
}
