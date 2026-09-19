/**
 * Heart rate's three phase bands, stored (D-H, zivaone_app T-26).
 *
 * Six `user_baseline` rows: `hr_{asleep,awake,active}_{lo,hi}`. The HR screen
 * has read these since D-H (`hr.phaseBands` prefers them), and the
 * `ziva.hr-out-of-band` rule compares against the asleep pair — but nothing
 * wrote them, so the screen fell back to computing bands inline and the rule
 * had nothing to read. One definition, computed here, is what lets the band
 * the user sees and the band the alert uses be the same band.
 *
 * ## The definition — the app's `hr.phaseBands` fallback, day-first
 *
 * 1. Every CLEAN heart-rate reading (T-25) over COMPLETE local days of the
 *    window is classified by phase, with the shared definitions:
 *      asleep  inside a sleep session
 *      active  >= STILL_FLOOR steps within +/-15 minutes (the §7g floor)
 *      awake   otherwise
 * 2. Per local day and phase, the day's edges: p10 and p90 of that phase's
 *    readings. A phase with fewer than PHASE_MIN_READINGS on a day does not
 *    contribute that day.
 * 3. Across days, the usual quantile pass — so a rail's `p50` is a TYPICAL
 *    day's edge, not the most extreme one in the window, and `sample_count`
 *    counts days. A rail needs BASELINE_MIN_DAYS days (principle 27) or it is
 *    not written: "learning" is the honest state, not a thin band.
 *
 * Kept out of `METRIC_METADATA` deliberately. These are not metrics a rule or
 * a tool can name; they are one metric's reference ranges, and six entries in
 * the metric enum would put `hr_active_hi` in every rule author's dropdown.
 */

import { BASELINE_MIN_DAYS } from '../core/metric_metadata'
import { readViewFor, STILL_FLOOR } from '../core/reading-quality'

export const HR_PHASES = ['asleep', 'awake', 'active'] as const
export type HrPhase = (typeof HR_PHASES)[number]

/** The six `user_baseline.metric` keys, in phase order, lo before hi. */
export const HR_PHASE_BAND_METRICS = HR_PHASES.flatMap(p => [`hr_${p}_lo`, `hr_${p}_hi`] as const)
export type HrPhaseBandMetric = (typeof HR_PHASE_BAND_METRICS)[number]

/** A phase-day needs this many readings to have edges (the app's floor). */
export const PHASE_MIN_READINGS = 6

/**
 * One row per rail that has enough days: `metric` plus the usual quantile
 * columns over that rail's daily values. Binds `$userId $brand $familyId $tz
 * $windowDays`; every parameter is CAST for the react-native-duckdb prepare
 * path (zivaone_app#70/#72).
 */
export function buildHrPhaseBandsSql(): string {
  const view = readViewFor('heart_rate')
  const windowBind = `(INTERVAL 1 DAY) * CAST($windowDays AS BIGINT)`
  // One extra day of scan for the zone offset; the HAVING decides the days.
  const scanBind = `(INTERVAL 1 DAY) * (CAST($windowDays AS BIGINT) + 1)`
  const localToday = `date_trunc('day', timezone(CAST($tz AS VARCHAR), now()))`
  const v = 'CAST(value AS DOUBLE)'
  return `
    WITH classified AS (
      SELECT
        date_trunc('day', timezone(CAST($tz AS VARCHAR), timezone('UTC', h.ts))) AS day,
        h.bpm,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM v_sleep_session ss
            WHERE ss.user_id = h.user_id AND ss.brand = h.brand AND ss.family_id = h.family_id
              AND h.ts >= ss.ts_start AND h.ts < ss.ts_end
          ) THEN 'asleep'
          -- Steps in [ts - 15, ts + 15) from v_motion running totals, by two
          -- ASOF lookups rather than a scan per reading.
          WHEN COALESCE(mn.cum_steps, 0) - COALESCE(mp.cum_steps, 0) >= ${STILL_FLOOR} THEN 'active'
          ELSE 'awake'
        END AS phase
      FROM ${view} h
      ASOF LEFT JOIN v_motion mp
        ON mp.user_id = h.user_id AND mp.brand = h.brand AND mp.family_id = h.family_id
       AND h.ts - INTERVAL 15 MINUTE > mp.ts
      ASOF LEFT JOIN v_motion mn
        ON mn.user_id = h.user_id AND mn.brand = h.brand AND mn.family_id = h.family_id
       AND h.ts + INTERVAL 15 MINUTE > mn.ts
      WHERE h.user_id = $userId AND h.brand = $brand AND h.family_id = $familyId
        AND h.ts > now() - ${scanBind}
    ),
    phase_days AS (
      SELECT day, phase,
             quantile_cont(bpm, 0.10) AS lo,
             quantile_cont(bpm, 0.90) AS hi
      FROM classified
      GROUP BY day, phase
      HAVING count(*) >= ${PHASE_MIN_READINGS}
         AND day >= ${localToday} - ${windowBind} AND day < ${localToday}
    ),
    rails AS (
      SELECT 'hr_' || phase || '_lo' AS metric, lo AS value FROM phase_days
      UNION ALL
      SELECT 'hr_' || phase || '_hi' AS metric, hi AS value FROM phase_days
    )
    SELECT metric,
           quantile_cont(${v}, 0.05) AS p05,
           quantile_cont(${v}, 0.10) AS p10,
           quantile_cont(${v}, 0.50) AS p50,
           quantile_cont(${v}, 0.90) AS p90,
           quantile_cont(${v}, 0.95) AS p95,
           avg(${v}) AS mean,
           stddev_samp(${v}) AS stddev,
           count(*) AS sample_count
    FROM rails
    GROUP BY metric
    HAVING count(*) >= ${BASELINE_MIN_DAYS}
    ORDER BY metric
  `.trim()
}
