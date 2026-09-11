/**
 * Sleep correction — Phase 2 SQL, ported from DataFusion to DuckDB.
 *
 * Source: ziva_app `sleepCorrectionLayer.ts` v3.1. The query SHAPE is kept as
 * v3.1 wrote it — same CTEs, same self-joins, same UNION ALL offset generator
 * — so a diff against the original reads as a list of dialect changes only:
 *
 *   - `TO_CHAR(TO_TIMESTAMP(d), fmt)` → `strftime(make_timestamp(d * 1000000), fmt)`.
 *     make_timestamp is naive UTC; `to_timestamp()` would be TIMESTAMPTZ and
 *     render in the session zone, breaking Phase 3's UTC parse.
 *   - `APPROX_PERCENTILE_CONT` → `quantile_cont` (exact). Expect ~1-unit
 *     drift on the tier/p75/p90 scalars; never retune constants to hide it.
 *   - The unused nested-window `session_start` column is dropped (DuckDB
 *     rejects nested windows; the final `start` recomputes it anyway).
 *   - Confidence literals are CAST to DOUBLE — DuckDB types `0.90` as DECIMAL,
 *     DataFusion as Float64.
 *
 * Numbers are inlined, as v3.1 does: every value is computed by this module
 * (epochs, tier, percentiles), never user input, and inlining sidesteps
 * react-native-duckdb's untyped-param bind (zivaone_app#70). `num()` refuses
 * anything non-finite.
 *
 * Relations are the v3.1 raw firmware shapes: sleep(date, quality, start,
 * "unitLength"), heartrate(date, "singleHR"), activity(date, step), epochs in
 * seconds. Production supplies staging views over the warehouse; the parity
 * harness supplies tables loaded from captures.
 */

import {
  CONF_ENVELOPE,
  CONF_FIRMWARE,
  CONF_GAP,
  EXTEND_AFTER,
  FETCH_AFTER,
  FETCH_BEFORE,
  HR_MAX,
  HR_MIN,
  LONG_GAP_HR_FRAC,
  LONG_GAP_MAX,
  LONG_GAP_MIN,
  STITCH_GAP_LONG,
  STITCH_GAP_MED,
  STITCH_GAP_SHORT,
} from './classify'

export interface SleepRelations {
  sleep: string
  heartrate: string
  activity: string
}

export const DEFAULT_RELATIONS: SleepRelations = {
  sleep: 'stg_sleep',
  heartrate: 'stg_heartrate',
  activity: 'stg_activity',
}

const IDENT_RE = /^[a-z_][\w.]*$/i

function rel(name: string): string {
  if (!IDENT_RE.test(name))
    throw new Error(`sleep-correction: invalid relation name ${JSON.stringify(name)}`)
  return name
}

function num(v: number): string {
  if (!Number.isFinite(v))
    throw new Error(`sleep-correction: non-finite SQL value ${String(v)}`)
  return String(v)
}

/** Once per sync. `hr_interval_minutes` is 5, 10 or 30 (v3.1 CASE, NULL ⇒ 30). */
export function detectHrTierSql(r: SleepRelations = DEFAULT_RELATIONS): string {
  return `
WITH hr_numbered AS (
    SELECT date,
           ROW_NUMBER() OVER (ORDER BY date) AS rn
    FROM ${rel(r.heartrate)}
    WHERE "singleHR" BETWEEN ${HR_MIN} AND ${HR_MAX}
),
hr_intervals AS (
    SELECT cur.date - COALESCE(prv.date, cur.date) AS gap_sec
    FROM hr_numbered cur
    LEFT JOIN hr_numbered prv ON prv.rn = cur.rn - 1
    WHERE cur.date - COALESCE(prv.date, cur.date) BETWEEN 61 AND 3599
),
median_gap AS (
    SELECT quantile_cont(gap_sec, 0.5) AS med
    FROM hr_intervals
)
SELECT
    med AS median_interval_seconds,
    CASE WHEN med <= 360  THEN 5
         WHEN med <= 900  THEN 10
         ELSE 30
    END AS hr_interval_minutes
FROM median_gap;`
}

/** Once per sync. Sleeping-HR p90 / p75 since `cutoffEpoch`; 120 when empty. */
export function globalBaselinesSql(cutoffEpoch: number, r: SleepRelations = DEFAULT_RELATIONS): string {
  return `
WITH hr_sleep AS (
    SELECT h."singleHR" AS hr
    FROM ${rel(r.heartrate)} h
    INNER JOIN ${rel(r.sleep)} s ON ABS(h.date - s.date) <= 30
    WHERE h."singleHR" BETWEEN ${HR_MIN} AND ${HR_MAX}
      AND CAST(s.quality AS INT) IN (1, 2, 3)
      AND h.date >= ${num(cutoffEpoch)}
)
SELECT
    COALESCE((SELECT quantile_cont(hr, 0.90) FROM hr_sleep), ${HR_MAX}) AS p90_global,
    COALESCE((SELECT quantile_cont(hr, 0.75) FROM hr_sleep), ${HR_MAX}) AS p75_global;`
}

/** Per night, before Phase 2: zero firmware sleep ⇒ skip the night entirely. */
export function hasSleepDataSql(windowStart: number, windowEnd: number, r: SleepRelations = DEFAULT_RELATIONS): string {
  return `
SELECT COUNT(*) AS has_data
FROM ${rel(r.sleep)}
WHERE date >= ${num(windowStart)}
  AND date <  ${num(windowEnd)}
  AND CAST(quality AS INT) IN (1, 2, 3, 5);`
}

/** Phase 2 — envelope extension, gap recovery and session stitching. */
export function correctNightSql(
  windowStart: number,
  windowEnd: number,
  hrIntervalMin: number,
  globalP75: number,
  globalP90: number,
  r: SleepRelations = DEFAULT_RELATIONS,
): string {
  const fetchStart = windowStart - FETCH_BEFORE
  const fetchEnd = windowEnd + FETCH_AFTER
  const offsets = Array.from({ length: hrIntervalMin }, (_, i) => `SELECT ${i} AS v`).join(' UNION ALL ')
  const ws = num(windowStart)
  const we = num(windowEnd)

  return `
WITH sleep_raw AS (
    SELECT
        date,
        CAST(quality AS INT)    AS quality,
        start                   AS fw_start,
        CAST("unitLength" AS INT) AS unit_length
    FROM ${rel(r.sleep)}
    WHERE date >= ${ws}
      AND date <  ${we}
      AND CAST(quality AS INT) IN (1, 2, 3, 5)
),

fw_bounds AS (
    SELECT
        COALESCE(MIN(date), ${ws}) AS first_fw,
        COALESCE(MAX(date), ${we}) AS last_fw
    FROM sleep_raw
    WHERE quality IN (1, 2, 3, 5)
),

night_hr AS (
    SELECT date, "singleHR" AS hr
    FROM ${rel(r.heartrate)}
    WHERE date >= ${num(fetchStart)}
      AND date <= ${num(fetchEnd)}
      AND "singleHR" BETWEEN ${HR_MIN} AND ${HR_MAX}
),

effective AS (
    SELECT
        fw_bounds.first_fw AS eff_start,
        fw_bounds.last_fw + ${EXTEND_AFTER} AS eff_end
    FROM fw_bounds
),

fw_trimmed AS (
    SELECT s.date, s.quality, s.fw_start, s.unit_length,
           CAST(${CONF_FIRMWARE} AS DOUBLE) AS confidence
    FROM sleep_raw s
    CROSS JOIN effective e
    WHERE s.date >= e.eff_start
      AND s.quality IN (1, 2, 3, 5)
),

fw_has_rows AS (
    SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS has_rows
    FROM sleep_raw
    WHERE quality IN (1, 2, 3, 5)
),

envelope_hr AS (
    SELECT h.date AS hr_epoch
    FROM night_hr h
    CROSS JOIN effective e
    CROSS JOIN fw_has_rows fhr
    CROSS JOIN fw_bounds fb
    WHERE fhr.has_rows = 1
      AND h.date >= fb.first_fw
      AND h.date <= e.eff_end
      AND h.hr   <= ${num(globalP90)}
      AND NOT EXISTS (
          SELECT 1 FROM sleep_raw fs
          WHERE ABS(fs.date - h.date) <= 30
            AND fs.quality IN (1, 2, 3, 5)
      )
),

offsets AS (${offsets}),

envelope_expanded AS (
    SELECT DISTINCT
        eh.hr_epoch + (o.v * 60) AS date,
        2                         AS quality,
        NULL                      AS fw_start,
        1                         AS unit_length,
        CAST(${CONF_ENVELOPE} AS DOUBLE) AS confidence
    FROM envelope_hr eh
    CROSS JOIN offsets o
    CROSS JOIN effective e
    WHERE eh.hr_epoch + (o.v * 60) >= e.eff_start
      AND eh.hr_epoch + (o.v * 60) <= e.eff_end
),

fw_sessions AS (
    SELECT fw_start,
           MIN(date) AS sess_start,
           MAX(date) AS sess_end,
           COUNT(*)  AS sess_len
    FROM sleep_raw
    WHERE quality IN (1, 2, 3, 5)
    GROUP BY fw_start
),

fw_sess_numbered AS (
    SELECT *,
           ROW_NUMBER() OVER (ORDER BY sess_start) AS rn
    FROM fw_sessions
),

fw_gaps AS (
    SELECT
        cur.sess_end   AS gap_start,
        nxt.sess_start AS gap_end,
        nxt.sess_start - cur.sess_end AS gap_sec
    FROM fw_sess_numbered cur
    LEFT JOIN fw_sess_numbered nxt ON nxt.rn = cur.rn + 1
    WHERE nxt.sess_start IS NOT NULL
      AND nxt.sess_start - cur.sess_end BETWEEN ${LONG_GAP_MIN} AND ${LONG_GAP_MAX}
),

gap_hr_check AS (
    SELECT
        fg.gap_start, fg.gap_end,
        CASE
            WHEN (SELECT has_rows FROM fw_has_rows) = 0 THEN 0
            WHEN COUNT(h.date) >= 3
             AND CAST(SUM(CASE WHEN h.hr <= ${num(globalP75)} THEN 1 ELSE 0 END) AS DOUBLE)
               / CAST(COUNT(h.date) AS DOUBLE) >= ${LONG_GAP_HR_FRAC}
            THEN 1 ELSE 0
        END AS qualifies
    FROM fw_gaps fg
    LEFT JOIN night_hr h
        ON h.date > fg.gap_start
       AND h.date < fg.gap_end
    GROUP BY fg.gap_start, fg.gap_end
),

gap_recovered AS (
    SELECT DISTINCT
        h.date + (o.v * 60) AS date,
        2                    AS quality,
        NULL                 AS fw_start,
        1                    AS unit_length,
        CAST(${CONF_GAP} AS DOUBLE) AS confidence
    FROM gap_hr_check gc
    INNER JOIN night_hr h
        ON h.date > gc.gap_start
       AND h.date < gc.gap_end
    CROSS JOIN offsets o
    WHERE gc.qualifies = 1
      AND h.date + (o.v * 60) > gc.gap_start
      AND h.date + (o.v * 60) < gc.gap_end
),

combined_raw AS (
    SELECT date, quality, fw_start, unit_length, confidence, 'firmware' AS source
    FROM fw_trimmed
    UNION ALL
    SELECT date, quality, fw_start, unit_length, confidence, 'envelope' AS source
    FROM envelope_expanded
    UNION ALL
    SELECT date, quality, fw_start, unit_length, confidence, 'gap' AS source
    FROM gap_recovered
),

deduped AS (
    SELECT date, quality, fw_start, unit_length, confidence, source
    FROM (
        SELECT *,
            ROW_NUMBER() OVER (
                PARTITION BY date
                ORDER BY CASE source WHEN 'firmware' THEN 0 ELSE 1 END
            ) AS rn
        FROM combined_raw
    )
    WHERE rn = 1
),

deduped_numbered AS (
    SELECT *,
           ROW_NUMBER() OVER (ORDER BY date) AS rn
    FROM deduped
),

with_gaps AS (
    SELECT
        cur.date, cur.quality, cur.fw_start, cur.unit_length,
        cur.confidence, cur.source, cur.rn,
        cur.date - COALESCE(prv.date, cur.date)           AS gap_to_prev,
        COALESCE(prv.unit_length, 0)                      AS prev_unit_length,
        COALESCE(prv.date, cur.date)                      AS prev_date
    FROM deduped_numbered cur
    LEFT JOIN deduped_numbered prv ON prv.rn = cur.rn - 1
),

stitched AS (
    SELECT
        date, quality, source, confidence,
        SUM(CASE
            WHEN gap_to_prev <= ${STITCH_GAP_SHORT}  THEN 0
            WHEN prev_unit_length = 120
             AND gap_to_prev <= ${STITCH_GAP_MED}    THEN 0
            WHEN gap_to_prev <= ${STITCH_GAP_MED}    THEN 0
            WHEN gap_to_prev <= ${STITCH_GAP_LONG}   THEN 0
            ELSE 1
        END) OVER (ORDER BY rn ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS session_id
    FROM with_gaps
)

SELECT
    strftime(make_timestamp(date * 1000000), '%Y.%m.%d %H:%M:%S') AS date,
    quality,
    strftime(make_timestamp(MIN(date) OVER (
        PARTITION BY session_id
    ) * 1000000), '%Y.%m.%d %H:%M:%S') AS start,
    1            AS "unitLength",
    source,
    confidence,
    session_id
FROM stitched
ORDER BY date;`
}

/** Phase 3 input — HR + step samples for the Step 5.6 END refinement. */
export function morningVitalsSql(windowStart: number, windowEnd: number, r: SleepRelations = DEFAULT_RELATIONS): string {
  return `
SELECT 'hr' AS kind, date AS epoch, "singleHR" AS value
FROM ${rel(r.heartrate)}
WHERE date >= ${num(windowStart)} AND date < ${num(windowEnd + FETCH_AFTER)}
  AND "singleHR" BETWEEN ${HR_MIN} AND ${HR_MAX}
UNION ALL
SELECT 'step' AS kind, date AS epoch, step AS value
FROM ${rel(r.activity)}
WHERE date >= ${num(windowStart)} AND date < ${num(windowEnd + FETCH_AFTER)}
ORDER BY epoch;`
}
