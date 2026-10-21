/*
 * Shared harness for the bounded-readers equivalence suites
 * (mongrov-packages#44): `bounded-readers-*.test.ts`.
 *
 * Those suites prove that every reader switched to a bounded macro — the
 * compiled rules, the HR phase bands, the AI tools — passes bounds that COVER
 * what its own WHERE selects, by running both forms and comparing every row.
 * The macros themselves are proven equal to their views filtered to `[lo, hi)`
 * by `bounded-quality-equivalence.test.ts`; this is the step after that.
 *
 * ## Clocks
 *
 * Readers anchor on `now()`. Each suite runs them at several clocks by
 * substituting a fixed instant for `now()` in BOTH forms, so the window start
 * lands at different offsets into the fixture's daily pattern: on the warm-up
 * onset after a gap, inside a step burst, next to a spike, at midnight. One
 * pass also runs on the real `now()` against data shifted to it.
 *
 * ## Fixture — the bounded-quality fixture, stretched to weeks
 *
 * Off-wrist at 00:00-01:00, no temperature at all until the onset at 02:30, a
 * short off-wrist dip at 15:00, a 10x temperature at 11:40, step bursts every
 * four hours and at 02:35, HR spikes and implausible values on coprime
 * periods, an SpO2 run of 86s every ~4.5 hours, a night's sleep every night,
 * a second user who never stops walking, and a few readings dated after each
 * clock (a ring whose clock runs a little fast).
 *
 * ## Thresholds
 *
 * A rule returns a row only when it fires, so equal EMPTY results prove
 * little. Each rule also runs with its thresholds pushed to both extremes,
 * which makes its HAVING pass and exposes the raw aggregate, run extreme or
 * day value to the comparison.
 *
 * ## Mutation
 *
 * `tighten` moves every bounded `lo` later, INSIDE the reader's window once
 * the spare day is spent; `seedSentinels` puts a burst of extreme readings
 * just inside each window start so that every reader's answer depends on
 * those rows. The mutation suite requires each reader to notice.
 */
import type { AnalyticsEngine } from '../../core/types'
import type { Rule } from '../../rules/schema'
import type { CompiledRule } from '../../rules/types'
import type { ToolImpl } from '../../tools/types'
import { expect } from 'vitest'
import { HybridDuckDB } from '../../core/engine'
import { LOCAL_SCHEMAS, TABLE_NAMES } from '../../core/schemas'
import { createViews } from '../../core/warehouse'
import { BAND_SCALE_PARAM, BASELINE_OFFSET_PARAM, compileRule, USER_SETTING_PARAM } from '../../rules/compiler'
import { luminxDefaults, vivaDefaults, yogaringDefaults, zivaDefaults } from '../../rules/defaults'
import { RuleSchema } from '../../rules/schema'
import { validateRule } from '../../rules/validator'
import { buildHrPhaseBandsSql } from '../../sync/hr-phase-bands'
import { detectAnomaly } from '../../tools/impls/anomaly'
import { compareTrend } from '../../tools/impls/compare'
import { getHeartRate } from '../../tools/impls/heart-rate'
import { getHRV } from '../../tools/impls/hrv'
import { getSpO2 } from '../../tools/impls/spo2'
import { getStress } from '../../tools/impls/stress'
import { getTemperature } from '../../tools/impls/temperature'
import { createRealDuckDB } from './real-engine'

export const B = 'ziva'
export const F = 'fam_1'
export const U = 'u1'
const U2 = 'u2'
/**
 * Default fixture length: every 30-day rule window and 30-day baseline (plus
 * its spare day) starts inside the data, and so does `compareTrend`'s 7 + 14.
 * Longer only costs time — the view forms scan all of it.
 */
export const DAYS = 33
const DAY_MS = 86_400_000

/** The fixture's last full day ends here; every clock sits just after it. */
export const END = Date.UTC(2026, 5, 20)
const iso = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ')

/**
 * Minutes after END. Chosen so a window's start falls on the fixture's edges:
 * the onset at 02:30 (150), inside the 02:35 burst, beside the 15:00 dip,
 * at midnight, and at odd offsets coprime with the 5-minute cadence.
 */
export const CLOCK_MINUTES = [0, 151, 7 * 60 + 13, 15 * 60 + 2, 1440 + 23 * 60 + 59]
export const clockAt = (minutes: number) => iso(END + minutes * 60_000)

const NOW_RE = /\bnow\(\)/gi
const BOUNDED_LO_RE = /_between\(timezone\('UTC', now\(\)\) - /g

/** Replace `now()` with a fixed UTC instant, in either form alike. */
export function atClock(sql: string, clock: string | undefined): string {
  return clock === undefined ? sql : sql.replace(NOW_RE, `CAST('${clock}+00' AS TIMESTAMPTZ)`)
}

/** Move every bounded `lo` later by `hours` — the "bound too tight" mutation. */
export function tighten(sql: string, hours: number): string {
  return sql.replace(BOUNDED_LO_RE, `_between(timezone('UTC', now()) + INTERVAL ${hours} HOUR - `)
}

export type Db = HybridDuckDB

async function seed(db: Db, origin: number, days: number, extraDays = 2): Promise<void> {
  const T0 = `TIMESTAMP '${iso(origin)}'`
  const total = days + extraDays
  const every = (step: number) => `generate_series(0, ${(total * 1440) / step - 1}) AS t(g)`
  const MOD = (step: number) => `((g * ${step}) % 1440)`
  const DAY = (step: number) => `((g * ${step}) // 1440)`

  await db.execute(`INSERT INTO temperature (ts, brand, family_id, user_id, device_id, temp_c)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U}','ring_1',
      CASE WHEN ${MOD(5)} < 60 THEN 22.0
           WHEN ${MOD(5)} BETWEEN 900 AND 929 THEN 22.0
           WHEN ${MOD(5)} = 700 THEN 365.0
           WHEN ${DAY(5)} % 6 IN (2, 3) THEN 37.6 + (g % 3) / 10.0
           ELSE 36.4 + (g % 4) / 10.0 END
    FROM ${every(5)}
    WHERE ${MOD(5)} NOT BETWEEN 60 AND 149`)

  await db.execute(`INSERT INTO heart_rate (ts, brand, family_id, user_id, device_id, bpm)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U}','ring_1',
      CASE WHEN g % 211 = 0 THEN 20
           WHEN g % 97 = 0 THEN 150
           WHEN ${MOD(5)} >= 1320 OR ${MOD(5)} < 360 THEN 48 + (g % 17) + ${DAY(5)} % 5
           ELSE 60 + (g % 20) + ${DAY(5)} % 7 END
    FROM ${every(5)}`)

  await db.execute(`INSERT INTO hrv (ts, brand, family_id, user_id, device_id, hrv_ms, stress)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U}','ring_1',
      CASE WHEN g % 113 = 0 THEN 0 ELSE 40 + (g % 30) - 3 * (${DAY(5)} % 6) END,
      CASE WHEN g % 89 = 0 THEN NULL ELSE 20 + (g % 50) + 4 * (${DAY(5)} % 5) END
    FROM ${every(5)}`)

  await db.execute(`INSERT INTO spo2 (ts, brand, family_id, user_id, device_id, spo2)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U}','ring_1',
      CASE WHEN g % 131 = 0 THEN 60
           WHEN g % 53 < 4 THEN 86
           ELSE 94 + (g % 5) END
    FROM ${every(5)}`)

  await db.execute(`INSERT INTO activity (ts, brand, family_id, user_id, device_id, steps)
    SELECT ${T0} + INTERVAL (g) MINUTE, '${B}','${F}','${U}','ring_1',
      CASE WHEN g % 240 < 10 THEN 40
           WHEN ${MOD(1)} BETWEEN 155 AND 164 THEN 40
           WHEN g % 97 < 3 THEN 2
           ELSE 0 END
    FROM ${every(1)}`)

  await db.execute(`INSERT INTO sleep_session (session_id, ts_start, ts_end, brand, family_id, user_id, device_id, total_minutes, night_of)
    SELECT 'n' || d, ${T0} + INTERVAL (d * 1440 - 120) MINUTE, ${T0} + INTERVAL (d * 1440 + 360) MINUTE,
      '${B}','${F}','${U}','ring_1', 420 + (d % 4) * 30, CAST(${T0} + INTERVAL (d * 1440) MINUTE AS DATE)
    FROM generate_series(1, ${total - 1}) AS t(d)`)

  // A second user walking constantly, on their own ring.
  await db.execute(`INSERT INTO activity (ts, brand, family_id, user_id, device_id, steps)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U2}','ring_2', 100 FROM ${every(5)}`)
  await db.execute(`INSERT INTO heart_rate (ts, brand, family_id, user_id, device_id, bpm)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U2}','ring_2', 110 FROM ${every(5)}`)

  // Stored baselines the baseline_offset and phase_band rules read.
  const baseline = (metric: string, windowDays: number, p50: number) => db.execute(
    `INSERT INTO user_baseline (brand, family_id, user_id, metric, window_days, p05, p10, p50, p90, p95, mean, stddev, sample_count, computed_at)
     VALUES ('${B}','${F}','${U}','${metric}', ${windowDays}, ${p50}, ${p50}, ${p50}, ${p50}, ${p50}, ${p50}, 1, 30, TIMESTAMP '${iso(END)}')`,
  )
  await baseline('temp_c', 30, 36.9)
  await baseline('hrv_ms', 30, 55)
  await baseline('stress', 30, 40)
  await baseline('hr_bpm', 30, 66)
  await baseline('hr_asleep_lo', 90, 50)
  await baseline('hr_asleep_hi', 90, 62)
  await baseline('hr_asleep_lo', 30, 49)
  await baseline('hr_asleep_hi', 30, 63)
}

/**
 * A seeded engine with every view and macro. `days` of history end at `END`
 * (or start at `origin`), plus two days after it.
 */
export async function open(opts: { days?: number, origin?: number } = {}): Promise<Db> {
  const days = opts.days ?? DAYS
  const db = new HybridDuckDB(() => createRealDuckDB(['icu']))
  await db.open()
  await db.execute(`SET TimeZone='UTC';`)
  for (const t of TABLE_NAMES) await db.execute(LOCAL_SCHEMAS[t])
  await seed(db, opts.origin ?? END - days * DAY_MS, days)
  const { unavailableMacros } = await createViews(db, { brand: B, familyId: F, localCatalog: 'memory' })
  expect(unavailableMacros).toEqual([])
  return db
}

// ── comparison ─────────────────────────────────────────────────────────────

/**
 * Rows as a canonical string. Floats are compared to 12 significant digits: an
 * AVG over the same rows read in a different order can differ in the last bit,
 * which is not a different answer.
 */
function canon(rows: unknown[]): string {
  return JSON.stringify(rows, (_k, v) => {
    if (typeof v === 'bigint')
      return v.toString()
    if (typeof v === 'number')
      return Number.isInteger(v) ? v : Number(v.toPrecision(12))
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)
      return String(v)
    return v
  })
}

export interface Tally {
  compared: number
  /** One line per disagreement. */
  differ: string[]
  /** Which readers disagreed at least once (rule id, tool name, band window). */
  differIds: Set<string>
  /** Which readers returned rows at least once. */
  nonEmpty: Set<string>
}
export const tally = (): Tally => ({ compared: 0, differ: [], differIds: new Set(), nonEmpty: new Set() })

// ── sentinels, for the mutation suite ──────────────────────────────────────

/**
 * Per table: the window starts (hours back from now) the readers of that
 * table can have, its reading cadence in minutes (`sampling_minutes`), and
 * per column the clean extremes beyond anything the fixture holds —
 * plausible, and on-wrist for temperature — walked toward normal by `step`.
 */
const SENTINELS = [
  { table: 'heart_rate', cadence: 10, offsets: [1, 6, 24, 168, 720], columns: [{ column: 'bpm', low: 30, high: 220, step: 1 }] },
  {
    table: 'hrv',
    cadence: 60,
    offsets: [6, 24, 72, 168, 192, 336, 504, 720],
    columns: [
      { column: 'hrv_ms', low: 5, high: 200, step: 1 },
      { column: 'stress', low: 0, high: 100, step: 1 },
    ],
  },
  { table: 'spo2', cadence: 30, offsets: [24, 168], columns: [{ column: 'spo2', low: 70, high: 100, step: 1 }] },
  { table: 'temperature', cadence: 30, offsets: [24, 168, 336, 720], columns: [{ column: 'temp_c', low: 30.0, high: 43.0, step: 0.1 }] },
] as const

const BLOCK_SLOTS = 4
const BURST_ROWS = 40

/**
 * Extreme readings just inside every window start a reader can have at
 * `clock`, so a bound cut 2 hours too tight drops rows the answer depends on.
 * Per window start, two parts:
 *
 *   burst  40 readings at +5..+9 minutes: enough weight to move a DAILY mean
 *          (day-cadence rules), however dense the fixture is.
 *   block  one reading per cadence slot for 4 slots from the first slot
 *          boundary after +20 minutes, with the fixture's own readings in
 *          those slots removed — a run `consecutive` rules can see, since
 *          runs are keyed on slots and the 5-minute fixture puts several
 *          readings in most of them.
 *
 * MONOTONE in age, both across window starts and within one: the burst and
 * the block's first reading are the most extreme values of their window
 * start, the rest of the block one `step` closer to normal, and an older
 * window start is more extreme than every younger one. A window always holds
 * the younger sentinels too, so equal values would let its MIN or MAX — or a
 * run's — survive losing its own oldest rows; this way they cannot.
 *
 * One side at a time (`low` or `high`): a mix would average out of a mean.
 * Removes fixture rows, so each call wants a freshly opened engine.
 */
export async function seedSentinels(db: Db, clockMs: number, side: 'low' | 'high'): Promise<void> {
  for (const spec of SENTINELS) {
    // `n` steps from the extreme toward normal.
    const level = (col: typeof spec.columns[number], n: number) => {
      const v = side === 'low' ? col.low + n * col.step : col.high - n * col.step
      return Math.round(v * 10) / 10
    }
    const rows: string[] = []
    for (const [idx, h] of spec.offsets.entries()) {
      // The oldest window start (largest offset, last index) is 0 steps out.
      const rank = 2 * (spec.offsets.length - 1 - idx)
      const extreme = spec.columns.map(c => level(c, rank))
      const nearer = spec.columns.map(c => level(c, rank + 1))
      const start = clockMs - h * 3_600_000
      for (let i = 0; i < BURST_ROWS; i++) {
        const t = start + 5 * 60_000 + Math.floor(i / 10) * 60_000 + (5 + (i % 10) * 5) * 1000
        rows.push(`(TIMESTAMP '${iso(t)}', '${B}','${F}','${U}','ring_1', ${extreme.join(', ')})`)
      }
      const slotMs = spec.cadence * 60_000
      const first = Math.ceil((start + 20 * 60_000) / slotMs) * slotMs
      await db.execute(`DELETE FROM ${spec.table} WHERE user_id = '${U}'
        AND ts >= TIMESTAMP '${iso(first)}' AND ts < TIMESTAMP '${iso(first + BLOCK_SLOTS * slotMs)}'`)
      for (let k = 0; k < BLOCK_SLOTS; k++) {
        const values = k === 0 ? extreme : nearer
        rows.push(`(TIMESTAMP '${iso(first + k * slotMs + 5000)}', '${B}','${F}','${U}','ring_1', ${values.join(', ')})`)
      }
    }
    const cols = spec.columns.map(c => c.column).join(', ')
    await db.execute(`INSERT INTO ${spec.table} (ts, brand, family_id, user_id, device_id, ${cols}) VALUES ${rows.join(',')}`)
  }
}

// ── rules ──────────────────────────────────────────────────────────────────

function synthetic(raw: Record<string, unknown>): Rule {
  const rule = RuleSchema.parse({ brand: B, severity: 'info', throttle: {}, name: String(raw.id), ...raw })
  validateRule(rule)
  return rule
}

/** One rule per shape the defaults do not already cover, and a few they do. */
export const SYNTHETIC: Rule[] = [
  synthetic({ id: 's.consecutive-abs-6h', metric: 'hr_bpm', window: '6h', aggregation: 'max', compare: 'greater_than', consecutive: 3, target: { type: 'absolute', value: 75 } }),
  synthetic({ id: 's.consecutive-range', metric: 'spo2', window: '24h', aggregation: 'min', compare: 'between', consecutive: 2, target: { type: 'range', min: 90, max: 99 } }),
  synthetic({ id: 's.consecutive-resting', metric: 'hrv_ms', window: '24h', aggregation: 'min', compare: 'less_than', context: 'resting', consecutive: 2, target: { type: 'user_setting', key: 'user:hrvDropMs', defaultValue: 45 } }),
  synthetic({ id: 's.cadence-abs-7d', metric: 'temp_c', window: '7d', aggregation: 'max', compare: 'greater_than', cadence: 'day', consecutive: 2, target: { type: 'absolute', value: 37.5 } }),
  synthetic({ id: 's.cadence-resting-offset', metric: 'hr_bpm', window: '30d', aggregation: 'avg', compare: 'less_than', context: 'resting', cadence: 'day', consecutive: 2, target: { type: 'baseline_offset', windowDays: 30, offset: 1, direction: 'below' } }),
  synthetic({ id: 's.per-session', metric: 'sleep_total_minutes', window: '7d', aggregation: 'avg', compare: 'less_than', target: { type: 'absolute', value: 480 } }),
  synthetic({ id: 's.band-defaults', metric: 'hr_bpm', window: '24h', aggregation: 'avg', compare: 'between', context: 'asleep', consecutive: 2, target: { type: 'phase_band', band: 'hr_asleep', windowDays: 30, defaultLo: 55, defaultHi: 70 } }),
  synthetic({ id: 's.band-resting-6h', metric: 'hr_bpm', window: '6h', aggregation: 'avg', compare: 'between', context: 'resting', consecutive: 2, target: { type: 'phase_band', band: 'hr_asleep', windowDays: 90 } }),
  synthetic({ id: 's.pct-resting-1h', metric: 'hr_bpm', window: '1h', aggregation: 'avg', compare: 'less_than', context: 'resting', target: { type: 'baseline_percent', windowDays: 7, percent: 90 } }),
  synthetic({ id: 's.stddev-asleep', metric: 'hr_bpm', window: '6h', aggregation: 'avg', compare: 'greater_than', context: 'asleep', target: { type: 'baseline_stddev', windowDays: 30, stddevs: 0.1 } }),
  synthetic({ id: 's.min-days', metric: 'spo2', window: '7d', aggregation: 'avg', compare: 'less_than', minDays: 5, target: { type: 'absolute', value: 97 } }),
  synthetic({ id: 's.last-3d', metric: 'stress', window: '3d', aggregation: 'last', compare: 'greater_than', target: { type: 'absolute', value: 30 } }),
  synthetic({ id: 's.count-resting-30d', metric: 'temp_c', window: '30d', aggregation: 'count', compare: 'greater_than', context: 'resting', target: { type: 'absolute', value: 10 } }),
]

export const DEFAULT_RULES: Rule[] = [...zivaDefaults, ...luminxDefaults, ...vivaDefaults, ...yogaringDefaults]
const RULES: Rule[] = [...DEFAULT_RULES, ...SYNTHETIC]

const refs = (sql: string, name: string) => new RegExp(`\\$${name}\\b`).test(sql)

/** Threshold-like params, and the two extremes that make any HAVING pass. */
const EXTREMES: Record<string, [number, number]> = {
  threshold_absolute: [-1e6, 1e6],
  [USER_SETTING_PARAM]: [-1e6, 1e6],
  [BASELINE_OFFSET_PARAM]: [-1e6, 1e6],
  pct: [0, 1e8],
  stddevs: [-1e6, 1e6],
  range_min: [-1e6, 1e6],
  range_max: [-1e6, 1e6],
  [BAND_SCALE_PARAM]: [1e-6, 1e6],
}

/**
 * The parameter sets a rule runs with: its defaults, then every threshold at
 * each extreme, in each zone when it binds `$tz`. `extremesOnly` keeps just
 * the extremes in UTC — the mutation suite's cheaper sweep.
 */
function paramSets(c: CompiledRule, extremesOnly = false): Record<string, unknown>[] {
  const sql = c.sql
  const base: Record<string, unknown> = { userId: U, brand: B, familyId: F, ...c.params }
  if (refs(sql, USER_SETTING_PARAM))
    base[USER_SETTING_PARAM] = c.userSettingDefault ?? 0
  if (refs(sql, BASELINE_OFFSET_PARAM) && base[BASELINE_OFFSET_PARAM] === undefined)
    base[BASELINE_OFFSET_PARAM] = c.offsetDefault ?? 0
  if (refs(sql, BAND_SCALE_PARAM) && base[BAND_SCALE_PARAM] === undefined)
    base[BAND_SCALE_PARAM] = 1
  const out: Record<string, unknown>[] = []
  // Local days east and west of UTC; the rule's own thresholds once, in UTC.
  const zones = refs(sql, 'tz') ? (extremesOnly ? ['UTC'] : ['Pacific/Kiritimati', 'America/Los_Angeles']) : [undefined]
  if (!extremesOnly)
    out.push(refs(sql, 'tz') ? { ...base, tz: 'UTC' } : base)
  for (const tz of zones) {
    const withTz = tz === undefined ? base : { ...base, tz }
    for (const side of [0, 1] as const) {
      const v = { ...withTz }
      let any = false
      for (const [k, ex] of Object.entries(EXTREMES)) {
        if (refs(sql, k)) {
          v[k] = ex[side]
          any = true
        }
      }
      if (any)
        out.push(v)
    }
  }
  if (out.length === 0)
    out.push(refs(sql, 'tz') ? { ...base, tz: 'UTC' } : base)
  return out
}

export const COMPILED = RULES.filter(r => !r.rawSql).map(r => compileRule(r))
export const BOUNDED_RULES = COMPILED.filter(c => c.boundedSql !== undefined)
const DEFAULT_IDS = new Set(DEFAULT_RULES.map(r => r.id))
export const BOUNDED_DEFAULTS = BOUNDED_RULES.filter(c => DEFAULT_IDS.has(c.ruleId))
export const BOUNDED_SYNTHETIC = BOUNDED_RULES.filter(c => !DEFAULT_IDS.has(c.ruleId))

interface CompareOpts {
  mutate?: (sql: string) => string
  extremesOnly?: boolean
  /** Skip readers already in `t.differIds` — the mutation suite's early exit. */
  skipDiffered?: boolean
}

export async function compareRules(db: Db, rules: CompiledRule[], clock: string | undefined, t: Tally, opts: CompareOpts = {}): Promise<void> {
  const mutate = opts.mutate ?? (s => s)
  for (const c of rules) {
    if (opts.skipDiffered && t.differIds.has(c.ruleId))
      continue
    for (const params of paramSets(c, opts.extremesOnly)) {
      const view = await db.execute(atClock(c.sql, clock), params)
      const bounded = await db.execute(atClock(mutate(c.boundedSql!), clock), params)
      t.compared += 1
      if (view.length > 0)
        t.nonEmpty.add(c.ruleId)
      if (canon(view) !== canon(bounded)) {
        t.differ.push(`${c.ruleId} @${clock} ${JSON.stringify(params)}: ${canon(view)} vs ${canon(bounded)}`)
        t.differIds.add(c.ruleId)
      }
    }
  }
}

// ── hr phase bands ─────────────────────────────────────────────────────────

export async function comparePhaseBands(
  db: Db,
  clock: string | undefined,
  t: Tally,
  opts: CompareOpts & { windows?: number[], zones?: string[] } = {},
): Promise<void> {
  const mutate = opts.mutate ?? (s => s)
  for (const windowDays of opts.windows ?? [7, 30, 90]) {
    for (const tz of opts.zones ?? ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      const params = { userId: U, brand: B, familyId: F, tz, windowDays }
      const view = await db.execute(atClock(buildHrPhaseBandsSql(), clock), params)
      const bounded = await db.execute(atClock(mutate(buildHrPhaseBandsSql({ bounded: true })), clock), params)
      t.compared += 1
      if (view.length > 0)
        t.nonEmpty.add(`${windowDays}`)
      if (canon(view) !== canon(bounded)) {
        t.differ.push(`phase-bands ${windowDays}d ${tz} @${clock}`)
        t.differIds.add(`${windowDays}`)
      }
    }
  }
}

// ── tools ──────────────────────────────────────────────────────────────────

/**
 * The engine a tool sees. Bounded: reports the capability, and a bounded
 * statement that fails is an ERROR here (`reportBoundedReadFailure` throws), so
 * the run-time fallback can never hide a broken bound from the comparison.
 * `failBounded` instead makes every bounded statement throw, to test that
 * fallback; the failures are counted in `failures`.
 */
function engine(db: Db, clock: string | undefined, boundedReads: boolean, mutate: (s: string) => string, failures?: { n: number }): AnalyticsEngine {
  return {
    boundedReads,
    reportBoundedReadFailure: () => {
      if (failures === undefined)
        throw new Error('a bounded statement failed in the equivalence harness')
      failures.n += 1
    },
    execute: (sql: string, params?: Record<string, unknown>) => {
      if (failures !== undefined && sql.includes('_between('))
        return Promise.reject(new Error('Binder Error: native only'))
      return db.execute(atClock(boundedReads ? mutate(sql) : sql, clock), params)
    },
  } as unknown as AnalyticsEngine
}

const TOOL_CASES: [string, ToolImpl<never>, Record<string, unknown>][] = [
  ...[1, 7, 30].map(days => ['getHRV', getHRV, { userId: U, days }] as [string, ToolImpl<never>, Record<string, unknown>]),
  ...[1, 7, 30].map(days => ['getHeartRate', getHeartRate, { userId: U, days }] as [string, ToolImpl<never>, Record<string, unknown>]),
  ...[1, 7].map(days => ['getStress', getStress, { userId: U, days }] as [string, ToolImpl<never>, Record<string, unknown>]),
  ...[1, 14].map(days => ['getTemperature', getTemperature, { userId: U, days }] as [string, ToolImpl<never>, Record<string, unknown>]),
  ...[1, 7].map(days => ['getSpO2', getSpO2, { userId: U, days }] as [string, ToolImpl<never>, Record<string, unknown>]),
  ['detectAnomaly', detectAnomaly, { userId: U, metric: 'hrv_ms', lookbackDays: 14, stddevThreshold: 1 }],
  ['compareTrend', compareTrend, { userId: U, metric: 'hrv_ms', currentWindowDays: 1, priorWindowDays: 7 }],
  ['compareTrend', compareTrend, { userId: U, metric: 'hrv_ms', currentWindowDays: 7, priorWindowDays: 14 }],
]

export const TOOL_NAMES = [...new Set(TOOL_CASES.map(([name]) => name))].sort()

export async function compareTools(
  db: Db,
  clock: string | undefined,
  t: Tally,
  opts: CompareOpts & { failBounded?: { n: number, warned: string[] }, zones?: string[] } = {},
): Promise<void> {
  const mutate = opts.mutate ?? (s => s)
  const fail = opts.failBounded
  // One zone per clock, alternating, so local days east of UTC are covered
  // without doubling every call.
  const zone = clock === undefined || Number(clock.slice(14, 16)) % 2 === 0 ? 'UTC' : 'Asia/Kolkata'
  for (const timezone of opts.zones ?? [zone]) {
    for (const [name, impl, input] of TOOL_CASES) {
      if (opts.skipDiffered && t.differIds.has(name))
        continue
      const ctx = (bounded: boolean) => ({
        requesterUserId: U,
        brand: B,
        familyId: F,
        timezone,
        analytics: engine(db, clock, bounded, mutate, bounded ? fail : undefined),
        logger: {
          debug() {},
          info() {},
          warn: (message: string, meta?: Record<string, unknown>) => {
            if (message === 'tools.bounded_failed')
              fail?.warned.push(String(meta?.tool))
          },
          error() {},
        },
      })
      const view = await impl(input as never, ctx(false))
      const bounded = await impl(input as never, ctx(true))
      t.compared += 1
      if (view.rowCount > 0)
        t.nonEmpty.add(name)
      if (view.text !== bounded.text) {
        t.differ.push(`${name} ${JSON.stringify(input)} ${timezone} @${clock}:\n${view.text}\n---\n${bounded.text}`)
        t.differIds.add(name)
      }
    }
  }
}
