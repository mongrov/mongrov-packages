/**
 * Signal-quality flags and clean-read views (sprint6 spec §13, T-25).
 *
 * Alpha ships processed metrics, not raw firmware values: a user must never
 * see a claim computed from a reading the ring could not honestly have taken
 * — a temperature from a ring on the nightstand, a 10x Android decode, one
 * 190 bpm spike between two 60s. (An SpO2 taken mid-gesture was on this list;
 * since zivaone_app#377 the motion gate is `QualityOptions.motionFilter`, off
 * by default, and whatever is shown is also what claims count.)
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
 * The ring reports no wear signal, so `worn` is inferred, heart rate first:
 *   - A heart-rate reading within WEAR_HR_EVIDENCE_MINUTES either side means
 *     worn. The firmware records no heart rate off the finger, so this is the
 *     ring's own proof of wear — and a heart-rate reading is its own evidence,
 *     so the wear gate never removes heart rate (zivaone_app#482).
 *   - Otherwise temperature decides: a reading below 30 C is ambient, not
 *     skin. A vital is judged by the latest temperature at or before it, and
 *     only if that temperature is recent — with no recent evidence the reading
 *     is assumed worn, because absence of a temperature is not evidence the
 *     ring was off.
 * Temperature alone hid worn readings: a worn ZR100/ZR200 reads 26-30 C on
 * cool skin, and in one QA export ten such readings removed 64 of 287 heart
 * rates and 11 of 47 SpO2s, each with a heart rate within 6 minutes.
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
/**
 * A heart-rate reading this close (either side) proves the ring was worn,
 * whatever the temperature says (zivaone_app#482, ruled 2026-10-28). Only a
 * plausible heart rate counts — the same clamp as `plausible`.
 */
export const WEAR_HR_EVIDENCE_MINUTES = 10
/** §13c: discard the first 10 minutes of TEMPERATURE after the ring goes back on. */
export const WARM_UP_MINUTES = 10
/** Same "still" test as the D-G resting metrics. See STILL_STEPS_PER_HOUR. */
export const STILL_WINDOW_MINUTES = 15

/**
 * How much movement counts as movement.
 *
 * `still` used to be "no activity row with steps > 0 within ±15 minutes",
 * which is not a movement test. A worn ring reports a handful of steps for
 * most waking minutes — standing up, crossing a room, shifting in a chair —
 * so on real step data almost every waking reading classified as moving,
 * `v_spo2_clean` and `v_hrv_clean` came back empty, and both screens drew
 * nothing at all. Not a degraded chart: an empty one, with no error anywhere.
 *
 * CREATIVE-RULES §7g already names the line between sitting and moving about,
 * in the Activity effort ramp's first tier: **still is under 100 steps an
 * hour**. Read it rather than inventing a second threshold, so a slot one
 * vital calls still and a cell Activity paints Still can never disagree.
 */
export const STILL_STEPS_PER_HOUR = 100

/**
 * The floor scaled to the window `still` actually measures.
 *
 * `STILL_WINDOW_MINUTES` is the half-width, so the window spans twice it
 * (±15 min = 30 minutes) and the floor is 50 steps. Derived rather than
 * written as `50`, so changing the window cannot silently leave the floor
 * describing a different span.
 */
export const STILL_FLOOR = Math.round(
  (STILL_STEPS_PER_HOUR * STILL_WINDOW_MINUTES * 2) / 60,
)
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
function wearJoin(source: string): string {
  return `ASOF LEFT JOIN ${source} w
    ON w.user_id = m.user_id AND w.brand = m.brand
   AND w.family_id = m.family_id AND w.device_id = m.device_id
   AND m.ts >= w.ts`
}

/**
 * The nearest plausible heart rate either side of each reading, same device:
 * `hp` at or before it, `hn` at or after. Only their `ts` is read.
 */
function hrEvidenceJoin(source: string): string {
  const on = (a: string) => `${a}.user_id = m.user_id AND ${a}.brand = m.brand
   AND ${a}.family_id = m.family_id AND ${a}.device_id = m.device_id`
  return `ASOF LEFT JOIN ${source} hp
    ON ${on('hp')}
   AND m.ts >= hp.ts
  ASOF LEFT JOIN ${source} hn
    ON ${on('hn')}
   AND m.ts <= hn.ts`
}

/** The plausible heart rates `hrEvidenceJoin` looks up, from `from`. */
function hrEvidenceRelation(from: string): string {
  return `(SELECT user_id, brand, family_id, device_id, ts FROM ${from}
    WHERE bpm BETWEEN ${BPM_MIN} AND ${BPM_MAX})`
}

const WORN = `CASE WHEN hp.ts >= m.ts - INTERVAL ${WEAR_HR_EVIDENCE_MINUTES} MINUTE
                OR hn.ts <= m.ts + INTERVAL ${WEAR_HR_EVIDENCE_MINUTES} MINUTE THEN TRUE
              WHEN w.ts IS NULL OR w.ts < m.ts - INTERVAL ${WEAR_EVIDENCE_MINUTES} MINUTE
              THEN TRUE ELSE w.on_wrist END`

const WARM_UP = `COALESCE(w.onset AND m.ts < w.ts + INTERVAL ${WARM_UP_MINUTES} MINUTE, FALSE)`

/**
 * A RUNNING STEP TOTAL per tenant — what `still` differences against.
 *
 * This used to be the minutes with any step at all (`steps > 0`), and `still`
 * asked whether such a minute existed nearby. That made one step within ±15
 * minutes enough to call a reading moving; see `STILL_STEPS_PER_HOUR` for why
 * that emptied the SpO2 and HRV screens.
 *
 * Carrying a cumulative total instead lets `still` subtract two lookups
 * (see MOTION_JOIN / STILL) rather than sum a window per reading, so the
 * lookup-not-scan shape from zivaone_app#126 is preserved — the predicate
 * changed, not the access pattern.
 *
 * RANGE framing (the default with ORDER BY) gives rows sharing a timestamp —
 * two rings on one family — the same running total, so a tie cannot split
 * them.
 *
 * `steps IS NOT NULL` rather than `steps > 0`: a zero-step minute is evidence
 * of stillness and must contribute a row, or the running total has gaps
 * exactly where the user was motionless.
 *
 * Two totals. `cum_steps` is per tenant, as it has always been: the app's day
 * grids difference it to describe the USER's day, and every one of them
 * relies on its shape. `cum_steps_device` restarts per ring, and is what
 * `still` reads (zivaone_app#366). A reading is judged by the steps of the
 * ring that took it: tenant-wide, a second ring's activity in the same
 * minutes (a replacement ring carrying its own history, a QA ring passed
 * between testers, the QA seed's mock ring) marked a still reading MOVING
 * and dropped it from the clean view. Measured on real DuckDB: another
 * ring's 60 steps in the window flipped an idle ring's SpO2 reading to
 * MOVING. The two totals must never be mixed in one difference; the
 * device-scoped one is only meaningful between two rows of the same ring,
 * which is why `motionJoin` matches `device_id`.
 */
function motionViewDdl(): string {
  return `CREATE OR REPLACE VIEW ${MOTION_VIEW} AS
SELECT user_id, brand, family_id, device_id, ts,
       SUM(steps) OVER (PARTITION BY user_id, brand, family_id ORDER BY ts) AS cum_steps,
       SUM(steps) OVER (PARTITION BY user_id, brand, family_id, device_id ORDER BY ts) AS cum_steps_device
FROM v_activity WHERE steps IS NOT NULL;`
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
function motionJoin(source: string): string {
  return `ASOF LEFT JOIN ${source} mp
    ON mp.user_id = m.user_id AND mp.brand = m.brand AND mp.family_id = m.family_id
   AND mp.device_id = m.device_id
   AND m.ts - INTERVAL ${STILL_WINDOW_MINUTES} MINUTE > mp.ts
  ASOF LEFT JOIN ${source} mn
    ON mn.user_id = m.user_id AND mn.brand = m.brand AND mn.family_id = m.family_id
   AND mn.device_id = m.device_id
   AND m.ts + INTERVAL ${STILL_WINDOW_MINUTES} MINUTE > mn.ts`
}

/**
 * Steps across the window, by subtraction rather than by summing.
 *
 * `mp` is the running total just before the window OPENS (the latest motion
 * row with `ts < m.ts - 15`), `mn` the total just before it CLOSES (latest
 * with `ts < m.ts + 15`). Their difference is exactly the steps in the
 * half-open window `[m.ts - 15, m.ts + 15)` — the same span the correlated
 * sum read, at two lookups instead of a scan per reading.
 *
 * Verified against that correlated definition on 864 readings spanning both
 * outcomes: zero disagreements.
 *
 * The half-open window is why both bounds use `>` on the same side: a step
 * exactly 15 minutes BEFORE a reading falls inside, one exactly 15 minutes
 * AFTER falls outside. A symmetric rewrite silently flips those readings, and
 * `still-equivalence.test.ts` pins both edges.
 *
 * COALESCE on both sides, not just one: `mp` is NULL for a reading in the
 * user's first 15 minutes of history, and `mn` for one in the last 15 — and
 * `NULL - NULL` would make `still` NULL rather than true, dropping the very
 * readings at the edges of the data.
 */
/**
 * Is there any activity row inside the window at all?
 *
 * `mn` is the latest motion row strictly before the window CLOSES. If that row
 * also falls at or after the window OPENS it is inside the window, so the
 * window holds evidence. If it sits earlier than the window opens — or there
 * is no row at all — then nothing was recorded near this reading and the
 * question "was the wearer still?" has no answer here.
 *
 * A pure comparison on columns the ASOF joins already produced: no extra
 * lookup, no scan (zivaone_app#126's shape is untouched).
 */
const MOTION_EVIDENCE = `(mn.ts IS NOT NULL AND mn.ts >= m.ts - INTERVAL ${STILL_WINDOW_MINUTES} MINUTE)`

/**
 * THREE-VALUED (zivaone_app#219): true, false, or NULL for "we cannot tell".
 *
 * This was a plain `delta < FLOOR`, which made absence of evidence read as
 * evidence of stillness. With no activity rows near a reading both ASOF
 * lookups land on the same distant row, the difference is 0, and 0 is below
 * any floor — so the reading was called STILL because nothing had been
 * recorded, not because the wearer was motionless.
 *
 * Measured on a real ring (zivaone_app#219): SpO2 readings between 08:30 and
 * 14:30 sat 1-7 hours from the nearest activity row and every one of them
 * passed as still. Overnight SpO2 was surviving the gate partly by accident,
 * and would have started failing had activity coverage improved.
 *
 * `steps IS NOT NULL` in `motionViewDdl` already says a zero-step minute is
 * evidence of stillness and must contribute a row. This is the other half of
 * that statement: where no row exists, there is no evidence either way.
 *
 * NULL rather than false, because "moving" would be just as wrong a claim as
 * "still". What each clean view does with unknown is its own decision -- see
 * `STILL_ENOUGH`.
 */
const STILL = `CASE WHEN ${MOTION_EVIDENCE}
           THEN (COALESCE(mn.cum_steps_device, 0) - COALESCE(mp.cum_steps_device, 0)) < ${STILL_FLOOR}
           ELSE NULL END`

/**
 * What the clean views do with a reading whose stillness is unknown: KEEP it.
 *
 * Stated here once, as an expression with a name, rather than as a bare
 * `COALESCE` inline in four view bodies -- this is a product decision and it
 * should be visible as one.
 *
 * Unknown passes because the commonest cause of it is a sleeping wearer: a
 * motionless night produces few activity rows, and dropping those readings
 * would empty the SpO2 and HRV screens overnight -- the exact regression
 * `STILL_STEPS_PER_HOUR` exists to have fixed. Treating unknown as moving
 * would trade a quiet wrong answer for a loud missing one.
 *
 * The honesty this buys is in the FLAG, not in the filter: `still` now says
 * which readings we actually know about, so the quality probe can separate
 * "moving" from "no idea" and a future consumer can decide differently
 * without re-deriving the window.
 */
export function stillEnoughSql(alias = ''): string {
  return `COALESCE(${alias}still, TRUE)`
}

const STILL_ENOUGH = stillEnoughSql()

/** What the quality DDL can be built with. */
export interface QualityOptions {
  /**
   * Whether a MOVING reading (`still = false`) is excluded from the clean
   * relations of the vitals the motion gate applies to: SpO2, HRV and
   * stress. Default **off** (zivaone_app#377).
   *
   * Off, a moving reading is clean if it passes every other gate, and that is
   * deliberate on BOTH sides of the clean relations. Screens read them, and so
   * do alerts, verdicts and baselines, so a reading the user can see is a
   * reading an alert can fire on. A screen showing a value that no alert
   * reacts to reads to the customer as a broken alert. The rule is that
   * alerts follow what is shown, never a stricter set.
   *
   * The `still` flag is computed either way: `v_{table}_q` keeps it for
   * diagnostics (`READING_QUALITY_COUNTS_SQL.moving`) and for turning the
   * gate back on without re-deriving the window.
   */
  motionFilter?: boolean
  /*
   * The other gates, one switch each so they can be turned back on one at a
   * time. Default **on**; `false` turns that gate off. Off, the readings it
   * would exclude are clean, and so are shown AND counted by alerts, verdicts
   * and baselines, the same rule as `motionFilter`. Its flag is still
   * computed for diagnostics. ZivaOne turns all four off for the v1 parity
   * check (spec §13 amendment 2026-10-22).
   */
  /** `worn`: no reading while the ring reads as off the finger (all vitals). */
  wearFilter?: boolean
  /** `warm_up`: temperature in the first minutes after the ring goes back on. */
  warmUpFilter?: boolean
  /**
   * `plausible`: the §13b clamps. Off, the Android 10x temperature value
   * (`scale_suspect`) is no longer caught.
   */
  rangeFilter?: boolean
  /** `spike`: an isolated heart rate far from both neighbours. */
  spikeFilter?: boolean
}

/** The motion term of a clean predicate: the still gate, or no gate at all. */
function motionGateSql(opts: QualityOptions): string {
  return opts.motionFilter === true ? STILL_ENOUGH : 'TRUE'
}

/** A gate's term while its switch is on (the default), `off` while it is off. */
function gateSql(on: boolean | undefined, term: string, off = 'TRUE'): string {
  return on === false ? off : term
}

/**
 * The wear term, for consumers that read the `_q` flags directly (the stress
 * raster keeps `active` hours, so it cannot read `_clean`). Reading `worn`
 * bare would hide readings that `wearFilter: false` shows.
 */
export function wearGateSql(opts: QualityOptions, alias = ''): string {
  return gateSql(opts.wearFilter, `${alias}worn`)
}

/** `plausible` while `rangeFilter` is on; off, just "the value is present". */
function rangeGateSql(opts: QualityOptions, column: string): string {
  return gateSql(opts.rangeFilter, 'plausible', `${column} IS NOT NULL`)
}

/**
 * `warm_up` is a TEMPERATURE gate. Skin temperature takes minutes to settle
 * after the ring goes back on; a heart rate, SpO2 or HRV read by PPG is good
 * from the first beat. It once gated all four, which hid ordinary readings
 * (82, 79, 87, 90 bpm) for ten minutes after every re-wear (zivaone_app#377).
 * The other tables keep the column, always FALSE, so every `_q` view has the
 * same shape and the exclusion counts stay honest.
 */
function sharedFlags(table: QualityTable): string {
  // A heart-rate reading is its own wear evidence (see WORN).
  return `${table === 'heart_rate' ? 'TRUE' : WORN} AS worn,
         ${table === 'temperature' ? WARM_UP : 'FALSE'} AS warm_up,
         ${STILL} AS still`
}

/**
 * Heart-rate readings with their `spike` flag. Spike needs both neighbours
 * present and close; an edge reading or one next to a gap cannot be judged
 * and is kept. A step change (60 → 110 → 120) is not a spike: the second
 * reading agrees with the first.
 */
function withSpike(base: string): string {
  return `SELECT *, COALESCE(
        LAG(ts) OVER n >= ts - INTERVAL ${SPIKE_NEIGHBOUR_MINUTES} MINUTE
        AND LEAD(ts) OVER n <= ts + INTERVAL ${SPIKE_NEIGHBOUR_MINUTES} MINUTE
        AND abs(bpm - LAG(bpm) OVER n) >= ${SPIKE_DELTA_BPM}
        AND abs(bpm - LEAD(bpm) OVER n) >= ${SPIKE_DELTA_BPM}, FALSE) AS spike
    FROM ${base}
    WINDOW n AS (${DEVICE_WINDOW})`
}

function heartRateQBody(src: QualitySources, opts: QualityOptions): string {
  return `SELECT *, COALESCE(${wearGateSql(opts)} AND ${rangeGateSql(opts, 'bpm')}
         AND ${gateSql(opts.spikeFilter, 'NOT spike')}, FALSE) AS clean
FROM (
  SELECT m.*, ${sharedFlags('heart_rate')},
         COALESCE(m.bpm BETWEEN ${BPM_MIN} AND ${BPM_MAX}, FALSE) AS plausible
  FROM (
    ${withSpike(src.base)}
  ) m
  ${motionJoin(src.motion)}
) f`
}

function spo2QBody(src: QualitySources, opts: QualityOptions): string {
  // Motion can corrupt the optical read; whether a moving SpO2 is excluded
  // for it is `QualityOptions.motionFilter`.
  return `SELECT *, COALESCE(${wearGateSql(opts)} AND ${rangeGateSql(opts, 'spo2')}
         AND ${motionGateSql(opts)}, FALSE) AS clean
FROM (
  SELECT m.*, ${sharedFlags('spo2')},
         COALESCE(m.spo2 BETWEEN ${SPO2_MIN} AND ${SPO2_MAX}, FALSE) AS plausible
  FROM ${src.base} m
  ${wearJoin(src.wear)}
  ${hrEvidenceJoin(src.hr)}
  ${motionJoin(src.motion)}
) f`
}

function temperatureQBody(src: QualitySources, opts: QualityOptions): string {
  // Android 10x guard: a value that only lands in range when divided by ten
  // is flagged, never divided. Corrected data is fabricated data.
  return `SELECT *, COALESCE(${wearGateSql(opts)} AND ${gateSql(opts.warmUpFilter, 'NOT warm_up')}
         AND ${rangeGateSql(opts, 'temp_c')}, FALSE) AS clean
FROM (
  SELECT m.*, ${sharedFlags('temperature')},
         COALESCE(m.temp_c BETWEEN ${TEMP_MIN} AND ${TEMP_MAX}, FALSE) AS plausible,
         COALESCE(m.temp_c > ${TEMP_MAX}
           AND m.temp_c / 10 BETWEEN ${TEMP_MIN} AND ${TEMP_MAX}, FALSE) AS scale_suspect
  FROM ${src.base} m
  ${wearJoin(src.wear)}
  ${hrEvidenceJoin(src.hr)}
  ${motionJoin(src.motion)}
) f`
}

function hrvQBody(src: QualitySources, opts: QualityOptions): string {
  // One row carries two vitals with different gates, so cleanliness is per
  // column. HRV: clamp, plus still when `motionFilter` is on (§13c). Stress:
  // no clamp; with `motionFilter` on, an `active` reading is masked from
  // alerting and tense-day counts (§13c) — the raw raster still shows it,
  // reading `v_hrv`. HRV 0 is below the 5 ms clamp:
  // the firmware reports it when RR variance is under its floor, which is a
  // real observation of "unmeasurable", not a measurement.
  return `SELECT *,
       COALESCE(hrv_ms IS NOT NULL AND ${wearGateSql(opts)} AND ${rangeGateSql(opts, 'hrv_ms')}
         AND ${motionGateSql(opts)}, FALSE) AS hrv_clean,
       COALESCE(stress IS NOT NULL AND ${wearGateSql(opts)} AND ${motionGateSql(opts)}, FALSE) AS stress_clean
FROM (
  SELECT m.*, ${sharedFlags('hrv')},
         COALESCE(m.hrv_ms BETWEEN ${HRV_MIN} AND ${HRV_MAX}, FALSE) AS plausible
  FROM ${src.base} m
  ${wearJoin(src.wear)}
  ${hrEvidenceJoin(src.hr)}
  ${motionJoin(src.motion)}
) f`
}

/** The clean projection of a quality relation, whatever `from` is. */
function cleanBody(table: QualityTable, from: string): string {
  const exclude = `EXCLUDE (${QUALITY_FLAG_COLUMNS[table].join(', ')})`
  if (table === 'hrv') {
    return `SELECT * ${exclude}
       REPLACE (CASE WHEN hrv_clean THEN hrv_ms END AS hrv_ms,
                CASE WHEN stress_clean THEN stress END AS stress)
FROM ${from}
WHERE hrv_clean OR stress_clean`
  }
  return `SELECT * ${exclude} FROM ${from} WHERE clean`
}

/**
 * Whether `table`'s clean predicate, under `opts`, reads a flag only the ASOF
 * joins produce: `worn` (SpO2, HRV, temperature — heart rate is always worn),
 * `warm_up` (temperature), `still` (SpO2
 * and HRV, while the motion gate is on). `plausible` and `spike` need no
 * join: one is the value itself, the other its neighbours in the same table.
 */
export function cleanNeedsJoins(table: QualityTable, opts: QualityOptions): boolean {
  // Heart rate: `worn` is always TRUE and no other gate it has needs a join.
  if (table === 'heart_rate')
    return false
  if (opts.wearFilter !== false)
    return true
  if (table === 'temperature')
    return opts.warmUpFilter !== false
  if (table === 'spo2' || table === 'hrv')
    return opts.motionFilter === true
  return false
}

/** `plausible`, or "present" while `rangeFilter` is off, from the value alone. */
function directRangeSql(opts: QualityOptions, column: string, [min, max]: readonly [number, number]): string {
  return opts.rangeFilter === false
    ? `${column} IS NOT NULL`
    : `COALESCE(${column} BETWEEN ${min} AND ${max}, FALSE)`
}

/**
 * The clean relation straight from the readings, for when no gate in force
 * needs a join (`cleanNeedsJoins` false).
 *
 * The `_q` bodies always join `v_wear` and `v_motion`: a `LAG` over the whole
 * temperature history and two running `SUM`s over the whole activity
 * history, windows nothing above them can prune. With the wear, warm-up and
 * motion gates off — every gate ZivaOne runs with for the v1 parity check —
 * the clean predicate reads none of what those joins produce, but every clean
 * read still paid for them. At 365 days, a full-history day count measured
 * 87 ms on `v_spo2_clean` and 245 ms on `v_temperature_clean` against 3.5 ms
 * on `v_spo2`, re-run after every sync (zivaone_app#505).
 *
 * Same rows, same columns, same order: an ASOF LEFT JOIN yields exactly one
 * row per reading, so the joins never added or dropped one, and the
 * predicate below is the `_q` one with the gates that are off already TRUE.
 * `clean-direct-equivalence.test.ts` compares the two for every combination
 * of options. The `_q` views are untouched — they still carry every flag for
 * diagnostics and the readers of `worn` / `warm_up`.
 */
function directCleanBody(table: QualityTable, base: string, opts: QualityOptions): string {
  switch (table) {
    case 'heart_rate':
      if (opts.spikeFilter === false)
        return `SELECT * FROM ${base} WHERE ${directRangeSql(opts, 'bpm', PLAUSIBLE_RANGES.bpm)}`
      return `SELECT * EXCLUDE (spike) FROM (
    ${withSpike(base)}
  ) m
WHERE ${directRangeSql(opts, 'bpm', PLAUSIBLE_RANGES.bpm)} AND NOT spike`
    case 'spo2':
      return `SELECT * FROM ${base} WHERE ${directRangeSql(opts, 'spo2', PLAUSIBLE_RANGES.spo2)}`
    case 'temperature':
      return `SELECT * FROM ${base} WHERE ${directRangeSql(opts, 'temp_c', PLAUSIBLE_RANGES.temp_c)}`
    case 'hrv':
      return `SELECT * EXCLUDE (hrv_clean, stress_clean)
       REPLACE (CASE WHEN hrv_clean THEN hrv_ms END AS hrv_ms,
                CASE WHEN stress_clean THEN stress END AS stress)
FROM (
  SELECT *,
         hrv_ms IS NOT NULL AND ${directRangeSql(opts, 'hrv_ms', PLAUSIBLE_RANGES.hrv_ms)} AS hrv_clean,
         stress IS NOT NULL AS stress_clean
  FROM ${base}
) m
WHERE hrv_clean OR stress_clean`
  }
}

function cleanViewDdl(table: QualityTable, opts: QualityOptions): string {
  const body = cleanNeedsJoins(table, opts)
    ? cleanBody(table, qualityViewFor(table))
    : directCleanBody(table, `v_${table}`, opts)
  return `CREATE OR REPLACE VIEW ${cleanViewFor(table)} AS
${body};`
}

/**
 * Where a quality body reads from. The views read the unbounded union views;
 * the bounded macros (below) read padded slices of the same rows. One body per
 * table serves both, so the two can never disagree about what a flag means.
 */
interface QualitySources {
  /** The readings being judged. */
  base: string
  /** Wear evidence, shaped like `v_wear`. */
  wear: string
  /** Running step total, shaped like `v_motion`. */
  motion: string
  /** Plausible heart-rate instants, for `hrEvidenceJoin`. */
  hr: string
}

const Q_BODY: Readonly<Record<QualityTable, (src: QualitySources, opts: QualityOptions) => string>> = {
  heart_rate: heartRateQBody,
  hrv: hrvQBody,
  spo2: spo2QBody,
  temperature: temperatureQBody,
}

function viewSources(table: QualityTable): QualitySources {
  return { base: `v_${table}`, wear: WEAR_VIEW, motion: MOTION_VIEW, hr: hrEvidenceRelation('v_heart_rate') }
}

function qualityViewDdl(table: QualityTable, opts: QualityOptions): string {
  return `CREATE OR REPLACE VIEW ${qualityViewFor(table)} AS
${Q_BODY[table](viewSources(table), opts)};`
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
export function qualityViewDdls(opts: QualityOptions = {}): QualityView[] {
  return [
    { name: WEAR_VIEW, sql: wearViewDdl() },
    // After the wear view, before the `_q` views that join it.
    { name: MOTION_VIEW, sql: motionViewDdl() },
    ...QUALITY_TABLES.map(t => ({ name: qualityViewFor(t), sql: qualityViewDdl(t, opts) })),
    ...QUALITY_TABLES.map(t => ({ name: cleanViewFor(t), sql: cleanViewDdl(t, opts) })),
  ]
}

/** Reverse creation order, so no view is dropped while another reads it. */
export function qualityViewNames(): string[] {
  return qualityViewDdls().map(v => v.name).reverse()
}

/**
 * The same quality flags, computed only over the window a query asks about.
 *
 * ## Why these exist (zivaone_app#121)
 *
 * The `_q` views ASOF-join `v_motion`, a running `SUM` over each tenant's
 * ENTIRE activity history, and `v_wear`, a `LAG` over the entire temperature
 * history. A window function over a whole partition cannot be pruned by a
 * filter above it, so a query for ONE day paid for every minute the ring was
 * ever worn: one day of `v_hrv_clean` cost as much as a year of it, and the
 * cost grew linearly with history (15 / 32 / 115 ms at 30 / 90 / 365 days for
 * a query returning one row). A screen firing 25 queries multiplied that.
 *
 * `v_{table}_q_between(lo, hi)` returns exactly the rows of `v_{table}_q` with
 * `lo <= ts < hi`, computed from padded slices instead. Cost tracks the
 * window, not the history: 5 ms against ~100 ms for one day at 365 days.
 *
 * `lo` and `hi` are UTC instants, compared against the stored `ts` directly —
 * a local-day window is converted by the caller, as every query already does.
 *
 * ## Why each pad is exact, not merely "wide enough"
 *
 * Every flag is a lookup relative to the reading. A slice gives the same
 * answer as the full table iff every lookup a reading in `[lo, hi)` makes
 * either lands inside the slice or would have produced the same value anyway.
 *
 *   - **Motion, +/- STILL_WINDOW_MINUTES.** `still` is `cum(mn) - cum(mp)`.
 *     The running total restarts at the slice start, but rows before `mp`
 *     count in both terms and cancel, so only `mp` and `mn` matter. The left
 *     pad makes `[ts - 15, ts)` fully present for the earliest reading; when
 *     the slice has no `mp`, every row up to `mn` is inside the window, which
 *     is exactly what the full table's difference sums. The right pad covers
 *     `mn` for the latest reading.
 *
 *   - **Wear, - WEAR_EVIDENCE_MINUTES.** `worn` is TRUE for any evidence older
 *     than that pad, so evidence the slice misses would have yielded TRUE
 *     anyway. `onset` compares a row with its PREDECESSOR, which a `LAG` over
 *     the slice gets wrong at the slice's first row — the one case the pad
 *     cannot cover. So the predecessor comes from an ASOF join against the
 *     unbounded `v_temperature`: a lookup, not a window, and exact.
 *
 *   - **Heart-rate wear evidence, +/- WEAR_HR_EVIDENCE_MINUTES.** Only a
 *     heart rate within that distance counts, so one outside the pad would
 *     not have counted in the full form either. Both ends are inclusive, as
 *     the comparisons in `WORN` are.
 *
 *   - **Heart-rate base, +/- SPIKE_NEIGHBOUR_MINUTES.** `spike` reads the
 *     immediate neighbours and only counts ones within that distance. A
 *     neighbour outside the pad is a gap in both forms.
 *
 * `bounded-quality-equivalence.test.ts` checks every flag of every table
 * against the views across hundreds of stepped windows, on a fixture built to
 * put each of these edges inside a window; each pad, and the ASOF onset, has
 * a mutation that the test catches.
 */
export function qualityMacroFor(table: QualityTable): string {
  return `${qualityViewFor(table)}_between`
}

export function cleanMacroFor(table: QualityTable): string {
  return `${cleanViewFor(table)}_between`
}

/**
 * A running step total over `[from, to)` only — `v_motion`'s shape, from a
 * slice. Shared by `v_motion_between` and every `_q` macro, so the two cannot
 * disagree about what "steps in a window" means.
 */
function motionSlice(from: string, to: string): string {
  return `  SELECT user_id, brand, family_id, device_id, ts,
         SUM(steps) OVER (PARTITION BY user_id, brand, family_id ORDER BY ts) AS cum_steps,
         SUM(steps) OVER (PARTITION BY user_id, brand, family_id, device_id ORDER BY ts) AS cum_steps_device
  FROM v_activity
  WHERE steps IS NOT NULL
    AND ts >= ${from}
    AND ts < ${to}`
}

/**
 * `v_motion`, bounded: the running step total over `[lo, hi)` only.
 *
 * For callers that difference two lookups themselves — "steps in this window"
 * as `cum(mn) - cum(mp)` — which is how the app's day grids and resting
 * queries measure movement (zivaone_app#181). Against `v_motion` those joins
 * paid for the user's whole activity history, a minute-resolution table and
 * the largest one; this pays for the window.
 *
 * ## `cum_steps` is RELATIVE to `lo`
 *
 * The total restarts at the slice start, so a row's `cum_steps` here is not
 * its `v_motion` value. Only a DIFFERENCE of two rows is the same quantity,
 * which is the only way `cum_steps` is meaningful anyway — `v_motion`'s
 * absolute value depends on where the history happens to begin.
 *
 * ## What the bounds must cover
 *
 * For a window `[a, b)` measured as `cum(latest < b) - cum(latest < a)`, pass
 * `lo <= a` and `hi >= b`. Rows before the earlier lookup count in both terms
 * and cancel; if the slice has no row before `a`, every row up to the later
 * lookup is inside the window, which is what the difference sums anyway. The
 * reasoning is the same as the `_q` macros' motion pad, and it shares their
 * slice.
 */
export const MOTION_MACRO = 'v_motion_between'

/**
 * The macro parameters, TYPED — never the bare `lo` / `hi`.
 *
 * DuckDB binds a macro body at `CREATE MACRO` time with its parameters still
 * untyped. A comparison (`ts >= lo`) lets it infer the type from the other
 * side; arithmetic (`lo - INTERVAL 15 MINUTE`) does not, and DuckDB raises
 * `ParameterNotResolvedException` internally. The desktop builds catch that
 * and move on. The react-native-duckdb build on device lets it ESCAPE, so the
 * CREATE fails, `createViews` failed, and attach went to `error` — no analytics
 * at all on device, including storing synced ring data (zivaone_app#191).
 * `v_motion_between`, which only compared, created fine; every `_q` macro,
 * which subtracts an interval, did not.
 *
 * An explicit CAST gives the parameter its type at bind time, so nothing is
 * left to resolve. It folds for a constant argument, so it costs no pruning.
 * `macro-param-types.test.ts` asserts every macro's parameters resolve.
 */
const LO = 'CAST(lo AS TIMESTAMP)'
const HI = 'CAST(hi AS TIMESTAMP)'

function motionMacroDdl(): string {
  return `CREATE OR REPLACE MACRO ${MOTION_MACRO}(lo, hi) AS TABLE
${motionSlice(LO, HI)};`
}

/** The `_base` slice pad: heart rate's spike reads neighbours up to this far out. */
function basePadFor(table: QualityTable): number {
  return table === 'heart_rate' ? SPIKE_NEIGHBOUR_MINUTES : 0
}

function qualityMacroDdl(table: QualityTable, opts: QualityOptions): string {
  const basePad = basePadFor(table)
  const sources: QualitySources = { base: '_base', wear: '_wear', motion: '_motion', hr: '_hr' }
  return `CREATE OR REPLACE MACRO ${qualityMacroFor(table)}(lo, hi) AS TABLE
WITH _motion AS (
${motionSlice(`${LO} - INTERVAL ${STILL_WINDOW_MINUTES} MINUTE`, `${HI} + INTERVAL ${STILL_WINDOW_MINUTES} MINUTE`)}
),
_wear AS (
  SELECT t.user_id, t.brand, t.family_id, t.device_id, t.ts,
         t.temp_c >= ${WEAR_TEMP_MIN_C} AS on_wrist,
         COALESCE(t.temp_c >= ${WEAR_TEMP_MIN_C} AND p.temp_c < ${WEAR_TEMP_MIN_C}, FALSE) AS onset
  FROM (SELECT * FROM v_temperature
        WHERE ts >= ${LO} - INTERVAL ${WEAR_EVIDENCE_MINUTES} MINUTE AND ts < ${HI}) t
  ASOF LEFT JOIN v_temperature p
    ON p.user_id = t.user_id AND p.brand = t.brand AND p.family_id = t.family_id
   AND p.device_id = t.device_id AND t.ts > p.ts
),
_hr AS (
  SELECT user_id, brand, family_id, device_id, ts FROM v_heart_rate
  WHERE bpm BETWEEN ${BPM_MIN} AND ${BPM_MAX}
    AND ts >= ${LO} - INTERVAL ${WEAR_HR_EVIDENCE_MINUTES} MINUTE
    AND ts <= ${HI} + INTERVAL ${WEAR_HR_EVIDENCE_MINUTES} MINUTE
),
_base AS (
  SELECT * FROM v_${table}
  WHERE ts >= ${LO} - INTERVAL ${basePad} MINUTE AND ts < ${HI} + INTERVAL ${basePad} MINUTE
)
SELECT * FROM (
${Q_BODY[table](sources, opts)}
) q
WHERE ts >= ${LO} AND ts < ${HI};`
}

function cleanMacroDdl(table: QualityTable, opts: QualityOptions): string {
  if (cleanNeedsJoins(table, opts)) {
    return `CREATE OR REPLACE MACRO ${cleanMacroFor(table)}(lo, hi) AS TABLE
${cleanBody(table, `${qualityMacroFor(table)}(${LO}, ${HI})`)};`
  }
  // The same padded slice the `_q` macro judges, so a spike at the window's
  // edge sees the neighbour just outside it.
  const pad = basePadFor(table)
  const base = `(SELECT * FROM v_${table}
  WHERE ts >= ${LO} - INTERVAL ${pad} MINUTE AND ts < ${HI} + INTERVAL ${pad} MINUTE) b`
  return `CREATE OR REPLACE MACRO ${cleanMacroFor(table)}(lo, hi) AS TABLE
SELECT * FROM (
${directCleanBody(table, base, opts)}
) c
WHERE ts >= ${LO} AND ts < ${HI};`
}

/**
 * Every bounded macro, in creation order (a clean macro calls its `_q` one).
 *
 * Kept apart from `qualityViewDdls` on purpose: callers drop that list with
 * `DROP VIEW`, which fails on a macro.
 */
export function qualityMacroDdls(opts: QualityOptions = {}): QualityView[] {
  return [
    { name: MOTION_MACRO, sql: motionMacroDdl() },
    ...QUALITY_TABLES.map(t => ({ name: qualityMacroFor(t), sql: qualityMacroDdl(t, opts) })),
    ...QUALITY_TABLES.map(t => ({ name: cleanMacroFor(t), sql: cleanMacroDdl(t, opts) })),
  ]
}

/**
 * The PLAIN form of a bounded macro: the view it bounds, filtered to
 * `[lo, hi)`. Same name, same rows, none of the speed.
 *
 * `createViews` installs this when a macro's real body fails to create (the
 * device-only binder failure of zivaone_app#191), so a reader that names the
 * macro still gets the right answer — at the view's cost — instead of a
 * missing-function error. The rows are the same by the equivalence the real
 * macros are tested to: each returns exactly its view's rows with
 * `lo <= ts < hi`. For `v_motion_between` the absolute `cum_steps` differs,
 * but only differences of it mean anything, and those agree.
 *
 * Comparisons only, no arithmetic on `lo`/`hi`: the shape `v_motion_between`
 * already had when every other macro failed on device.
 */
const BETWEEN_SUFFIX_RE = /_between$/

export function fallbackMacroDdl(name: string): string {
  const view = name.replace(BETWEEN_SUFFIX_RE, '')
  return `CREATE OR REPLACE MACRO ${name}(lo, hi) AS TABLE
SELECT * FROM ${view} WHERE ts >= ${LO} AND ts < ${HI};`
}

/** Reverse creation order, for `DROP MACRO TABLE`. */
export function qualityMacroNames(): string[] {
  return qualityMacroDdls().map(m => m.name).reverse()
}

function countsFor(table: QualityTable, excluded: string, extra: { spike?: boolean, scale?: boolean } = {}): string {
  return `SELECT '${table}' AS metric,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE ${excluded}) AS excluded,
       COUNT(*) FILTER (WHERE NOT worn) AS off_wrist,
       COUNT(*) FILTER (WHERE warm_up) AS warm_up,
       COUNT(*) FILTER (WHERE NOT plausible) AS implausible,
       COUNT(*) FILTER (WHERE still IS FALSE) AS moving,
       COUNT(*) FILTER (WHERE still IS NULL) AS motion_unknown,
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
 * BIGINT. `moving` is reported for every vital; it gates SpO2 and HRV only
 * when `QualityOptions.motionFilter` is on.
 */
export const READING_QUALITY_COUNTS_SQL = [
  countsFor('heart_rate', 'NOT clean', { spike: true }),
  countsFor('hrv', 'NOT hrv_clean'),
  countsFor('spo2', 'NOT clean'),
  countsFor('temperature', 'NOT clean', { scale: true }),
].join('\nUNION ALL\n')
