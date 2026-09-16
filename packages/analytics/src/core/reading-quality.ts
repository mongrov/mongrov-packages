/**
 * Signal-quality flags and clean-read views (sprint6 spec §13, T-25).
 *
 * Alpha ships processed metrics, not raw firmware values: a user must never
 * see a claim computed from a reading the ring could not honestly have taken
 * — a temperature from a ring on the nightstand, a 10x Android decode, an
 * SpO2 taken mid-gesture, one 190 bpm spike between two 60s.
 *
 * Two view layers per vital, on top of the `v_{table}` union views:
 *
 *   v_{table}_q      every reading + its flags (`worn`, `warm_up`, `still`,
 *                    `plausible`, and `spike` / `scale_suspect` where they
 *                    apply). Diagnostics read this.
 *   v_{table}_clean  same columns as `v_{table}`, dirty readings removed.
 *                    Baselines, rules, verdicts and narratives read this —
 *                    the §13 consume rule.
 *
 * Why views and not flag columns written at ingest (§13a says "computed once
 * at sync"):
 *   - Most flags need neighbours. A spike is judged against the readings
 *     either side; warm-up against the previous temperature. Sync is delta and
 *     rows are insert-only, so the neighbour that decides a flag often arrives
 *     in a LATER sync than the reading it decides.
 *   - Columns need a migration locally AND an ALTER on the remote Iceberg
 *     tables, which the device cannot issue; a local-only column breaks the
 *     `SELECT *` union in `v_{table}`.
 *   - Plausibility is a pure function of the value, so computing it at read
 *     time gives the same answer ingest would.
 *
 * Excluded readings are flagged, never deleted: the raw row stays in
 * `v_{table}` for charts (which may mute or omit them) and diagnostics.
 *
 * The ring reports no wear signal, so `worn` comes from temperature: a
 * reading below 30 C is ambient, not skin. A vital is judged by the latest
 * temperature at or before it, and only if that temperature is recent — with
 * no recent evidence the reading is assumed worn, because absence of a
 * temperature is not evidence the ring was off.
 *
 * Two helper views feed the flags, both built before the `_q` views:
 *   v_wear    per temperature reading: is the ring on, and is this the
 *             warm-up onset?
 *   v_motion  the minutes the user was moving, which `still` looks up.
 *
 * Both exist so the flags are computed by LOOKUP rather than by scan. `still`
 * was once a correlated subquery over minute-resolution activity and cost
 * ~33 s on a 180-day clean scan on its own (zivaone_app#126); as an ASOF
 * lookup it costs single-digit milliseconds for identical rows.
 */

import type { ViewedTable } from './schemas'

export const QUALITY_TABLES = ['heart_rate', 'hrv', 'spo2', 'temperature'] as const satisfies readonly ViewedTable[]
export type QualityTable = (typeof QUALITY_TABLES)[number]

/** §13b clamps, inclusive. Outside ⇒ `plausible = false`. */
export const PLAUSIBLE_RANGES = {
  temp_c: [30, 43],
  spo2: [70, 100],
  bpm: [30, 220],
  hrv_ms: [5, 200],
} as const

/** Below this the ring is reading ambient air, not skin. */
export const WEAR_TEMP_MIN_C = 30
/** How long a temperature reading counts as wear evidence for later vitals. */
export const WEAR_EVIDENCE_MINUTES = 60
/** §13c: discard the first 10 minutes after the ring goes back on. */
export const WARM_UP_MINUTES = 10
/** Same "still" test as rule context `resting` and the D-G resting metrics. */
export const STILL_WINDOW_MINUTES = 15
/** §13c: a reading this far from BOTH neighbours is a single-slot spike. */
export const SPIKE_DELTA_BPM = 40
/** Neighbours further apart than this are a gap, not neighbours. */
export const SPIKE_NEIGHBOUR_MINUTES = 60

/** Flag columns each `_q` view adds, in order. The `_clean` view drops them. */
export const QUALITY_FLAG_COLUMNS: Readonly<Record<QualityTable, readonly string[]>> = {
  heart_rate: ['spike', 'worn', 'warm_up', 'still', 'plausible', 'clean'],
  hrv: ['worn', 'warm_up', 'still', 'plausible', 'hrv_clean', 'stress_clean'],
  spo2: ['worn', 'warm_up', 'still', 'plausible', 'clean'],
  temperature: ['worn', 'warm_up', 'still', 'plausible', 'scale_suspect', 'clean'],
}

export function isQualityTable(table: string): table is QualityTable {
  return (QUALITY_TABLES as readonly string[]).includes(table)
}

export function qualityViewFor(table: QualityTable): string {
  return `v_${table}_q`
}

export function cleanViewFor(table: QualityTable): string {
  return `v_${table}_clean`
}

/**
 * The view a claim-producing query reads for `table`: the clean view for a
 * vital, the plain union view for everything else.
 */
export function readViewFor(table: string): string {
  return isQualityTable(table) ? cleanViewFor(table) : `v_${table}`
}

const WEAR_VIEW = 'v_wear'
const MOTION_VIEW = 'v_motion'

const [TEMP_MIN, TEMP_MAX] = PLAUSIBLE_RANGES.temp_c
const [SPO2_MIN, SPO2_MAX] = PLAUSIBLE_RANGES.spo2
const [BPM_MIN, BPM_MAX] = PLAUSIBLE_RANGES.bpm
const [HRV_MIN, HRV_MAX] = PLAUSIBLE_RANGES.hrv_ms

const DEVICE_WINDOW = 'PARTITION BY user_id, brand, family_id, device_id ORDER BY ts'

/**
 * Per temperature reading: is the ring on, and is this the first on-wrist
 * reading after an off-wrist one (the warm-up onset)? The very first reading
 * of a device is not an onset — nothing says it was just put on.
 */
function wearViewDdl(): string {
  return `CREATE OR REPLACE VIEW ${WEAR_VIEW} AS
SELECT user_id, brand, family_id, device_id, ts,
       temp_c >= ${WEAR_TEMP_MIN_C} AS on_wrist,
       COALESCE(temp_c >= ${WEAR_TEMP_MIN_C}
         AND LAG(temp_c) OVER (${DEVICE_WINDOW}) < ${WEAR_TEMP_MIN_C}, FALSE) AS onset
FROM v_temperature;`
}

/** Latest wear evidence at or before each reading, same device. */
const WEAR_JOIN = `ASOF LEFT JOIN ${WEAR_VIEW} w
    ON w.user_id = m.user_id AND w.brand = m.brand
   AND w.family_id = m.family_id AND w.device_id = m.device_id
   AND m.ts >= w.ts`

const WORN = `CASE WHEN w.ts IS NULL OR w.ts < m.ts - INTERVAL ${WEAR_EVIDENCE_MINUTES} MINUTE
              THEN TRUE ELSE w.on_wrist END`

const WARM_UP = `COALESCE(w.onset AND m.ts < w.ts + INTERVAL ${WARM_UP_MINUTES} MINUTE, FALSE)`

/**
 * The minutes the user was moving — the set `still` is really asking about.
 *
 * Tenant-scoped, not device-scoped: a step recorded by one ring silences a
 * reading taken by another on the same family, which is what the rules'
 * `resting` join does and what `still` has always meant here.
 */
function motionViewDdl(): string {
  return `CREATE OR REPLACE VIEW ${MOTION_VIEW} AS
SELECT user_id, brand, family_id, ts FROM v_activity WHERE steps > 0;`
}

/**
 * Nearest motion either side of a reading.
 *
 * `still` used to be a correlated `NOT EXISTS` against `v_activity`, re-run
 * per reading over a +/-15 minute window. That single predicate dominated
 * every clean-view scan: `v_heart_rate_clean` measured 1 ms without it and
 * 32,958 ms with it at 180 days, and the HR day grid 36,172 ms
 * (zivaone_app#126). Activity is minute-resolution, so the subquery scanned
 * ~1,440 rows per day per reading.
 *
 * Two ASOF joins answer the same question by lookup instead of by scan:
 * `mp` = latest motion at-or-before the reading, `mn` = earliest motion
 * strictly after it. Aliases avoid `n`, which `heartRateQDdl` already uses as
 * a WINDOW name.
 */
const MOTION_JOIN = `ASOF LEFT JOIN ${MOTION_VIEW} mp
    ON mp.user_id = m.user_id AND mp.brand = m.brand AND mp.family_id = m.family_id
   AND m.ts >= mp.ts
  ASOF LEFT JOIN ${MOTION_VIEW} mn
    ON mn.user_id = m.user_id AND mn.brand = m.brand AND mn.family_id = m.family_id
   AND m.ts < mn.ts`

/**
 * Exactly the old predicate, re-expressed. The old window was HALF-OPEN
 * (`a.ts >= m.ts - 15 AND a.ts < m.ts + 15`); splitting it at `m.ts` gives
 * "no motion in [m.ts-15, m.ts]" and "no motion in (m.ts, m.ts+15)", i.e.
 * the two bounds below.
 *
 * The `>=` on the right edge is load-bearing: it is what keeps the window
 * half-open, so a step exactly 15 minutes BEFORE a reading marks it moving
 * while one exactly 15 minutes AFTER does not. A symmetric rewrite
 * (`BETWEEN`, or `>` here) silently flips those readings.
 * `__integration__/__tests__/still-equivalence.test.ts` proves row-for-row
 * equality against the original, pins both edges, and covers the
 * two-devices-one-family case that a device-scoped rewrite would break.
 */
const STILL = `((mp.ts IS NULL OR mp.ts <  m.ts - INTERVAL ${STILL_WINDOW_MINUTES} MINUTE)
          AND (mn.ts IS NULL OR mn.ts >= m.ts + INTERVAL ${STILL_WINDOW_MINUTES} MINUTE))`

function sharedFlags(): string {
  return `${WORN} AS worn,
         ${WARM_UP} AS warm_up,
         ${STILL} AS still`
}

function heartRateQDdl(): string {
  // Spike needs both neighbours present and close; an edge reading or one
  // next to a gap cannot be judged and is kept. A step change (60 → 110 →
  // 120) is not a spike: the second reading agrees with the first.
  return `CREATE OR REPLACE VIEW ${qualityViewFor('heart_rate')} AS
SELECT *, COALESCE(worn AND NOT warm_up AND plausible AND NOT spike, FALSE) AS clean
FROM (
  SELECT m.*, ${sharedFlags()},
         COALESCE(m.bpm BETWEEN ${BPM_MIN} AND ${BPM_MAX}, FALSE) AS plausible
  FROM (
    SELECT *, COALESCE(
        LAG(ts) OVER n >= ts - INTERVAL ${SPIKE_NEIGHBOUR_MINUTES} MINUTE
        AND LEAD(ts) OVER n <= ts + INTERVAL ${SPIKE_NEIGHBOUR_MINUTES} MINUTE
        AND abs(bpm - LAG(bpm) OVER n) >= ${SPIKE_DELTA_BPM}
        AND abs(bpm - LEAD(bpm) OVER n) >= ${SPIKE_DELTA_BPM}, FALSE) AS spike
    FROM v_heart_rate
    WINDOW n AS (${DEVICE_WINDOW})
  ) m
  ${WEAR_JOIN}
  ${MOTION_JOIN}
) f;`
}

function spo2QDdl(): string {
  // Motion corrupts the optical read, so a moving SpO2 is excluded outright.
  return `CREATE OR REPLACE VIEW ${qualityViewFor('spo2')} AS
SELECT *, COALESCE(worn AND NOT warm_up AND plausible AND still, FALSE) AS clean
FROM (
  SELECT m.*, ${sharedFlags()},
         COALESCE(m.spo2 BETWEEN ${SPO2_MIN} AND ${SPO2_MAX}, FALSE) AS plausible
  FROM v_spo2 m
  ${WEAR_JOIN}
  ${MOTION_JOIN}
) f;`
}

function temperatureQDdl(): string {
  // Android 10x guard: a value that only lands in range when divided by ten
  // is flagged, never divided. Corrected data is fabricated data.
  return `CREATE OR REPLACE VIEW ${qualityViewFor('temperature')} AS
SELECT *, COALESCE(worn AND NOT warm_up AND plausible, FALSE) AS clean
FROM (
  SELECT m.*, ${sharedFlags()},
         COALESCE(m.temp_c BETWEEN ${TEMP_MIN} AND ${TEMP_MAX}, FALSE) AS plausible,
         COALESCE(m.temp_c > ${TEMP_MAX}
           AND m.temp_c / 10 BETWEEN ${TEMP_MIN} AND ${TEMP_MAX}, FALSE) AS scale_suspect
  FROM v_temperature m
  ${WEAR_JOIN}
  ${MOTION_JOIN}
) f;`
}

function hrvQDdl(): string {
  // One row carries two vitals with different gates, so cleanliness is per
  // column. HRV: clamp + still (§13c). Stress: no clamp, but an `active`
  // reading is masked from alerting and tense-day counts (§13c) — the raw
  // raster still shows it, reading `v_hrv`. HRV 0 is below the 5 ms clamp:
  // the firmware reports it when RR variance is under its floor, which is a
  // real observation of "unmeasurable", not a measurement.
  return `CREATE OR REPLACE VIEW ${qualityViewFor('hrv')} AS
SELECT *,
       COALESCE(hrv_ms IS NOT NULL AND worn AND NOT warm_up AND plausible AND still, FALSE) AS hrv_clean,
       COALESCE(stress IS NOT NULL AND worn AND NOT warm_up AND still, FALSE) AS stress_clean
FROM (
  SELECT m.*, ${sharedFlags()},
         COALESCE(m.hrv_ms BETWEEN ${HRV_MIN} AND ${HRV_MAX}, FALSE) AS plausible
  FROM v_hrv m
  ${WEAR_JOIN}
  ${MOTION_JOIN}
) f;`
}

function cleanViewDdl(table: QualityTable): string {
  const exclude = `EXCLUDE (${QUALITY_FLAG_COLUMNS[table].join(', ')})`
  if (table === 'hrv') {
    return `CREATE OR REPLACE VIEW ${cleanViewFor('hrv')} AS
SELECT * ${exclude}
       REPLACE (CASE WHEN hrv_clean THEN hrv_ms END AS hrv_ms,
                CASE WHEN stress_clean THEN stress END AS stress)
FROM ${qualityViewFor('hrv')}
WHERE hrv_clean OR stress_clean;`
  }
  return `CREATE OR REPLACE VIEW ${cleanViewFor(table)} AS
SELECT * ${exclude} FROM ${qualityViewFor(table)} WHERE clean;`
}

const Q_DDL: Readonly<Record<QualityTable, () => string>> = {
  heart_rate: heartRateQDdl,
  hrv: hrvQDdl,
  spo2: spo2QDdl,
  temperature: temperatureQDdl,
}

export interface QualityView {
  name: string
  sql: string
}

/**
 * Every quality view, in creation order (each reads only earlier ones and
 * the `v_{table}` union views). They carry no tenant literal — the union
 * views underneath already bake it in — so they are recreated alongside them
 * on every attach and need no context.
 */
export function qualityViewDdls(): QualityView[] {
  return [
    { name: WEAR_VIEW, sql: wearViewDdl() },
    // After the wear view, before the `_q` views that join it.
    { name: MOTION_VIEW, sql: motionViewDdl() },
    ...QUALITY_TABLES.map(t => ({ name: qualityViewFor(t), sql: Q_DDL[t]() })),
    ...QUALITY_TABLES.map(t => ({ name: cleanViewFor(t), sql: cleanViewDdl(t) })),
  ]
}

/** Reverse creation order, so no view is dropped while another reads it. */
export function qualityViewNames(): string[] {
  return qualityViewDdls().map(v => v.name).reverse()
}

function countsFor(table: QualityTable, excluded: string, extra: { spike?: boolean, scale?: boolean } = {}): string {
  return `SELECT '${table}' AS metric,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE ${excluded}) AS excluded,
       COUNT(*) FILTER (WHERE NOT worn) AS off_wrist,
       COUNT(*) FILTER (WHERE warm_up) AS warm_up,
       COUNT(*) FILTER (WHERE NOT plausible) AS implausible,
       COUNT(*) FILTER (WHERE NOT still) AS moving,
       ${extra.spike ? 'COUNT(*) FILTER (WHERE spike)' : 'CAST(0 AS BIGINT)'} AS spike,
       ${extra.scale ? 'COUNT(*) FILTER (WHERE scale_suspect)' : 'CAST(0 AS BIGINT)'} AS scale_suspect
FROM ${qualityViewFor(table)}
WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
  AND ts > now() - (INTERVAL 1 DAY) * CAST($days AS BIGINT)`
}

/**
 * Diagnostic count of excluded readings per vital and reason (§13d: a
 * `scale_suspect` temperature surfaces here, never on a user-facing
 * surface). Binds `$userId`, `$brand`, `$familyId`, `$days`. Counts are
 * BIGINT. `moving` is reported for every vital but gates only SpO2 and HRV.
 */
export const READING_QUALITY_COUNTS_SQL = [
  countsFor('heart_rate', 'NOT clean', { spike: true }),
  countsFor('hrv', 'NOT hrv_clean'),
  countsFor('spo2', 'NOT clean'),
  countsFor('temperature', 'NOT clean', { scale: true }),
].join('\nUNION ALL\n')
