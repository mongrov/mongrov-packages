/**
 * T-25 (sprint6 spec §13) — signal-quality gates, executed.
 *
 * `firmware-dirty-readings.json` goes through the real mapper into real
 * DuckDB, and the views come from `createViews` — the attach path — so this
 * exercises exactly what a device builds. The fixture's `$comment` narrates
 * the morning; every expectation below traces to one sentence of it.
 *
 * Three layers of claim:
 *   1. flags: each dirty reading carries the right flag, and a near miss
 *      (a real HR rise, an ordinary HR during a walk) does not
 *   2. consumers: baselines, rules and tools read the clean views
 *   3. end to end: the same compiled rule fires on the raw view and stays
 *      silent on the clean one — the control that proves (1) and (2) compose
 *
 * The views are built with the motion filter ON, so every gate is exercised.
 * The last block rebuilds them with the default (off) and checks the other
 * half of the contract: a moving reading is shown AND alerts on.
 */
import type { FirmwareExport, MapperContext } from '../../sync/mapper/types'
import type { MetricId } from '../metric_metadata'
import type { QualityTable } from '../reading-quality'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { compileRule } from '../../rules/compiler'
import { RuleSchema } from '../../rules/schema'
import { buildBaselineSql } from '../../sync/baseline-compute'
import { mapFirmwareExport } from '../../sync/mapper/firmware'
import { HybridDuckDB } from '../engine'
import { getBaselineMetricIds, METRIC_METADATA } from '../metric_metadata'
import {
  cleanViewFor,
  isQualityTable,
  QUALITY_TABLES,
  qualityViewFor,
  READING_QUALITY_COUNTS_SQL,
} from '../reading-quality'
import { LOCAL_SCHEMAS, TABLE_NAMES } from '../schemas'
import { createViews } from '../warehouse'

const BRAND = 'ziva'
const FAMILY = 'fam_q'
const USER = 'user_q'

const ctx: MapperContext = {
  brand: BRAND,
  familyId: FAMILY,
  userId: USER,
  deviceId: 'ring_q',
  userTimezone: 'UTC',
}

const FIXTURE_NOON = Date.UTC(2026, 7, 20, 12)
/**
 * Rules window on `now()`, so the fixture morning is moved to end an hour
 * ago. A whole-hour shift keeps every reading on its 10-minute grid; none of
 * the flags depend on the absolute date.
 */
const SHIFT_MS = Math.floor(Date.now() / 3_600_000) * 3_600_000 - FIXTURE_NOON

let db: HybridDuckDB

function toLiteral(value: unknown): string {
  if (value === null || value === undefined)
    return 'NULL'
  if (value instanceof Date)
    return `TIMESTAMP '${new Date(value.getTime() + SHIFT_MS).toISOString().replace('T', ' ').replace('Z', '')}'`
  if (typeof value === 'number')
    return String(value)
  return `'${String(value).replace(/'/g, '\'\'')}'`
}

async function insertRows(table: string, rows: object[]): Promise<void> {
  for (const row of rows as Record<string, unknown>[]) {
    const cols = Object.keys(row)
    await db.execute(
      `INSERT INTO memory.${table} (${cols.join(', ')}) VALUES (${cols.map(c => toLiteral(row[c])).join(', ')})`,
    )
  }
}

async function column<T>(sql: string): Promise<T[]> {
  const rows = await db.execute<{ v: T }>(sql, { u: USER })
  return rows.map(r => r.v)
}

beforeAll(async () => {
  db = new HybridDuckDB(() => createRealDuckDB(['icu']))
  await db.open()
  for (const t of TABLE_NAMES) await db.execute(LOCAL_SCHEMAS[t])
  await createViews(db, { brand: BRAND, familyId: FAMILY, localCatalog: 'memory', quality: { motionFilter: true } })

  const fw: FirmwareExport = JSON.parse(readFileSync(
    join(__dirname, '../../sync/mapper/__tests__/fixtures/firmware-dirty-readings.json'),
    'utf-8',
  ))
  const batch = mapFirmwareExport(fw, ctx, { now: new Date('2026-08-21T00:00:00Z') })
  for (const t of ['temperature', 'heart_rate', 'spo2', 'hrv', 'activity'] as const)
    await insertRows(t, batch[t])
  // Not in the shared fixture (yet): an SpO2 on the nightstand with no heart
  // rate within 10 minutes, so wear is still exercised on temperature alone
  // now that heart rate is wear evidence (#482).
  await insertRows('spo2', [{ ...batch.spo2[0], ts: new Date('2026-08-20T06:40:00Z'), spo2: 95 }])
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('temperature — worn, warm-up, and the Android 10x guard', () => {
  it('flags the ambient run, the warm-up onset and the 10x value', async () => {
    const rows = await db.execute<{ t: number, worn: boolean, warm_up: boolean, scale_suspect: boolean, clean: boolean }>(
      `SELECT temp_c::DOUBLE AS t, worn, warm_up, scale_suspect, clean
       FROM v_temperature_q WHERE user_id = $u ORDER BY ts`,
      { u: USER },
    )
    expect(rows.map(r => r.t)).toEqual([24, 23, 24, 35, 36, 36, 37, 365, 36, 36, 37])
    // 06:00 and 06:30 are off-wrist; the 07:00 24 C has a heart rate beside it (#482).
    expect(rows.map(r => r.worn)).toEqual([false, false, true, true, true, true, true, true, true, true, true])
    // Only the first on-wrist reading after an off-wrist one is warming up.
    expect(rows.map(r => r.warm_up)).toEqual([false, false, false, true, false, false, false, false, false, false, false])
    expect(rows.filter(r => r.scale_suspect).map(r => r.t)).toEqual([365])
  })

  it('keeps six readings and never divides the 10x one into range', async () => {
    const temps = await column<number>(`SELECT temp_c::DOUBLE AS v FROM v_temperature_clean WHERE user_id = $u ORDER BY ts`)
    expect(temps).toEqual([36, 36, 37, 36, 36, 37])
    // Flag, never correct: 36.5 would be a fabricated reading.
    expect(temps).not.toContain(36.5)
  })
})

describe('heart rate — spike rejection', () => {
  it('flags the isolated 190 and the 250, not the real 110 → 120 rise', async () => {
    const spikes = await column<number>(`SELECT bpm AS v FROM v_heart_rate_q WHERE user_id = $u AND spike ORDER BY ts`)
    expect(spikes).toEqual([190, 250])
  })

  it('drops spike and clamped readings, never a heart rate for wear — 23 survive', async () => {
    const bpm = await column<number>(`SELECT bpm AS v FROM v_heart_rate_clean WHERE user_id = $u ORDER BY ts`)
    expect(bpm).toHaveLength(23)
    expect(bpm).not.toContain(190)
    // The 07:30 re-wear reading stays: warm-up is a temperature gate (#377).
    // 07:00-07:20 beside a 24 C reading: a heart rate is its own wear evidence (#482).
    expect(bpm.slice(0, 7)).toEqual([52, 50, 51, 88, 70, 66, 64])
    expect(await column<boolean>(`SELECT bool_and(worn) AS v FROM v_heart_rate_q WHERE user_id = $u`)).toEqual([true])
    expect(Math.max(...bpm)).toBe(120)
  })

  it('is not gated on movement — a walking HR is a real HR', async () => {
    const moving = await column<number>(`SELECT bpm AS v FROM v_heart_rate_q WHERE user_id = $u AND NOT still AND clean ORDER BY ts`)
    expect(moving).toEqual([64, 70, 60])
  })
})

describe('SpO2 — motion gate', () => {
  it('excludes the mid-walk 88 and the clamped 65; keeps the re-wear 94', async () => {
    const spo2 = await column<number>(`SELECT spo2 AS v FROM v_spo2_clean WHERE user_id = $u ORDER BY ts`)
    expect(spo2).toEqual([94, 97, 97, 96, 97, 97])
  })
})

describe('HRV + stress — per-column gates on a shared row', () => {
  it('nulls the HRV 0 but keeps its stress; drops the active hour entirely', async () => {
    const rows = await db.execute<{ hrv_ms: number | null, stress: number | null }>(
      `SELECT hrv_ms, stress FROM v_hrv_clean WHERE user_id = $u ORDER BY ts`,
      { u: USER },
    )
    expect(rows).toEqual([
      { hrv_ms: 45, stress: 30 },
      { hrv_ms: null, stress: 35 },
      { hrv_ms: 48, stress: 32 },
    ])
  })

  it('leaves the active stress hour on the raw view for the raster', async () => {
    expect(await column<number>(`SELECT stress AS v FROM v_hrv WHERE user_id = $u AND stress = 72`)).toEqual([72])
  })
})

describe('clean views keep the union view shape', () => {
  it.each(QUALITY_TABLES)('%s: same columns, same order', async (t) => {
    const cols = async (view: string) =>
      (await db.execute<{ column_name: string }>(`DESCRIBE ${view}`)).map(r => r.column_name)
    expect(await cols(cleanViewFor(t))).toEqual(await cols(`v_${t}`))
  })
})

describe('diagnostic counts', () => {
  it('surfaces the 10x temperature as a count, nowhere else', async () => {
    const rows = await db.execute<Record<string, unknown>>(READING_QUALITY_COUNTS_SQL, {
      userId: USER,
      brand: BRAND,
      familyId: FAMILY,
      days: 2,
    })
    const by = Object.fromEntries(rows.map(r => [r.metric, r]))
    const n = (m: string, k: string) => Number(by[m][k])
    expect(n('temperature', 'scale_suspect')).toBe(1)
    expect(n('temperature', 'excluded')).toBe(5)
    expect(n('temperature', 'off_wrist')).toBe(2)
    expect(n('heart_rate', 'spike')).toBe(2)
    expect(n('heart_rate', 'off_wrist')).toBe(0)
    expect(n('heart_rate', 'excluded')).toBe(2)
    expect(n('spo2', 'off_wrist')).toBe(1)
    expect(n('spo2', 'excluded')).toBe(3)
    expect(n('hrv', 'excluded')).toBe(2)
    for (const m of ['heart_rate', 'spo2', 'hrv']) {
      expect(n(m, 'scale_suspect')).toBe(0)
      expect(n(m, 'warm_up')).toBe(0) // a temperature gate only (#377)
    }
  })
})

describe('consumers read the clean views', () => {
  const bareView = (t: QualityTable) => new RegExp(`\\bv_${t}(?![_a-z])`)

  it('every baseline over a vital', () => {
    const metrics = getBaselineMetricIds().filter(m => isQualityTable(METRIC_METADATA[m].table))
    expect(metrics.length).toBeGreaterThan(0)
    for (const m of metrics) {
      const t = METRIC_METADATA[m].table as QualityTable
      const sql = buildBaselineSql(m, 30)
      expect(sql, m).toContain(cleanViewFor(t))
      expect(sql, m).not.toMatch(bareView(t))
    }
  })

  it('every rule over a vital', () => {
    for (const m of ['hr_bpm', 'resting_hr', 'hrv_ms', 'stress', 'spo2', 'temp_c'] as MetricId[]) {
      const t = METRIC_METADATA[m].table as QualityTable
      const { sql } = compileRule(rule(m, 'max', 'greater_than', 0))
      expect(sql, m).toContain(`FROM ${cleanViewFor(t)} m`)
      expect(sql, m).not.toMatch(bareView(t))
    }
  })
})

function rule(metric: MetricId, aggregation: string, compare: string, value: number) {
  return RuleSchema.parse({
    id: `test.quality-${metric}`,
    name: `quality ${metric}`,
    metric,
    window: '24h',
    aggregation,
    compare,
    severity: 'warn',
    target: { type: 'absolute', value },
  })
}

async function fires(sql: string, params: Record<string, unknown>): Promise<boolean> {
  const available: Record<string, unknown> = { userId: USER, brand: BRAND, familyId: FAMILY, tz: 'UTC', ...params }
  const bound = Object.fromEntries(Object.entries(available).filter(([k]) => sql.includes(`$${k}`)))
  return (await db.execute(sql, bound)).length > 0
}

describe('a dirty reading can never fire an alert', () => {
  // Each case is a rule the dirty reading alone would trip. The control runs
  // the SAME compiled SQL against the raw view: if it did not fire, the
  // silence on the clean view would prove nothing.
  it.each([
    ['temp_c', 'max', 'greater_than', 38, 'the 10x 365'],
    ['hr_bpm', 'max', 'greater_than', 150, 'the 190 spike / 250 clamp'],
    ['spo2', 'min', 'less_than', 90, 'the mid-walk 88 / clamped 65'],
    ['hrv_ms', 'min', 'less_than', 10, 'the HRV 0'],
    ['stress', 'max', 'greater_than_or_equal', 66, 'the active-hour 72'],
  ] as const)('%s %s %s %d — %s', async (metric, agg, compare, value) => {
    const t = METRIC_METADATA[metric].table as QualityTable
    const compiled = compileRule(rule(metric, agg, compare, value))
    expect(await fires(compiled.sql, compiled.params)).toBe(false)
    const raw = compiled.sql.replaceAll(cleanViewFor(t), `v_${t}`)
    expect(raw).not.toBe(compiled.sql)
    expect(await fires(raw, compiled.params)).toBe(true)
  })

  it('the quality view names are what the SQL reads', () => {
    for (const t of QUALITY_TABLES) expect(qualityViewFor(t)).toBe(`v_${t}_q`)
  })
})

describe('motion filter off (the default) — moving readings are shown, and alert', () => {
  // zivaone_app#377: alerts follow what is shown. Off, a moving reading is in
  // the clean view the screens read, so the rules reading the same view must
  // be able to fire on it; every other gate still applies.
  beforeAll(async () => {
    await createViews(db, { brand: BRAND, familyId: FAMILY, localCatalog: 'memory' })
  })

  it('keeps the mid-walk 88; still drops the clamped 65', async () => {
    const spo2 = await column<number>(`SELECT spo2 AS v FROM v_spo2_clean WHERE user_id = $u ORDER BY ts`)
    expect(spo2).toContain(88)
    expect(spo2).not.toContain(65)
    expect(spo2).toHaveLength(7)
  })

  it('the bounded macro agrees with the view', async () => {
    const view = await column<number>(`SELECT spo2 AS v FROM v_spo2_clean WHERE user_id = $u ORDER BY ts`)
    const bounded = await column<number>(
      `SELECT spo2 AS v FROM v_spo2_clean_between(TIMESTAMP '2000-01-01', TIMESTAMP '2100-01-01') WHERE user_id = $u ORDER BY ts`,
    )
    expect(bounded).toEqual(view)
  })

  it('keeps the active stress hour; the HRV 0 is still nulled', async () => {
    const stress = await column<number>(`SELECT stress AS v FROM v_hrv_clean WHERE user_id = $u ORDER BY ts`)
    expect(stress).toContain(72)
    const hrv = await column<number | null>(`SELECT hrv_ms AS v FROM v_hrv_clean WHERE user_id = $u ORDER BY ts`)
    expect(hrv).toContain(null)
  })

  it('still computes the flag, so moving readings stay countable', async () => {
    const moving = await column<number>(
      `SELECT spo2 AS v FROM v_spo2_q WHERE user_id = $u AND still IS FALSE AND clean`,
    )
    expect(moving).toEqual([88])
  })

  it.each([
    ['spo2', 'min', 'less_than', 90, 'the mid-walk 88'],
    ['stress', 'max', 'greater_than_or_equal', 66, 'the active-hour 72'],
  ] as const)('%s %s %s %d fires on %s', async (metric, agg, compare, value) => {
    const compiled = compileRule(rule(metric, agg, compare, value))
    expect(await fires(compiled.sql, compiled.params)).toBe(true)
  })
})

describe('gate switches off (v1 parity) — every reading is shown, and alerts', () => {
  // Spec §13 amendment 2026-10-22: each gate is its own switch so they can be
  // turned back on one at a time. A gate that is off makes its readings clean,
  // so the alerts reading the same views count them (principle 69).
  const ALL_OFF = { wearFilter: false, warmUpFilter: false, rangeFilter: false, spikeFilter: false }

  async function withQuality(quality: Record<string, boolean>): Promise<void> {
    await createViews(db, { brand: BRAND, familyId: FAMILY, localCatalog: 'memory', quality })
  }

  it('all off: the clean views hold every reading of the raw views', async () => {
    await withQuality(ALL_OFF)
    for (const t of ['temperature', 'heart_rate', 'spo2'] as const) {
      const raw = await column<number>(`SELECT count(*)::INTEGER AS v FROM v_${t} WHERE user_id = $u`)
      const clean = await column<number>(`SELECT count(*)::INTEGER AS v FROM v_${t}_clean WHERE user_id = $u`)
      expect(clean).toEqual(raw)
    }
    const temps = await column<number>(`SELECT temp_c::DOUBLE AS v FROM v_temperature_clean WHERE user_id = $u ORDER BY ts`)
    expect(temps).toEqual([24, 23, 24, 35, 36, 36, 37, 365, 36, 36, 37])
    const bpm = await column<number>(`SELECT bpm AS v FROM v_heart_rate_clean WHERE user_id = $u`)
    expect(bpm).toEqual(expect.arrayContaining([190, 250]))
    const hrv = await column<number | null>(`SELECT hrv_ms AS v FROM v_hrv_clean WHERE user_id = $u`)
    expect(hrv).toContain(0)
  })

  it('all off: the flags are still computed, so diagnostics keep counting', async () => {
    await withQuality(ALL_OFF)
    const suspect = await column<number>(`SELECT temp_c::DOUBLE AS v FROM v_temperature_q WHERE user_id = $u AND scale_suspect`)
    expect(suspect).toEqual([365])
    const spikes = await column<number>(`SELECT bpm AS v FROM v_heart_rate_q WHERE user_id = $u AND spike ORDER BY ts`)
    expect(spikes).toEqual([190, 250])
  })

  it('all off: the bounded macro agrees with the view', async () => {
    await withQuality(ALL_OFF)
    const view = await column<number>(`SELECT bpm AS v FROM v_heart_rate_clean WHERE user_id = $u ORDER BY ts`)
    const bounded = await column<number>(
      `SELECT bpm AS v FROM v_heart_rate_clean_between(TIMESTAMP '2000-01-01', TIMESTAMP '2100-01-01') WHERE user_id = $u ORDER BY ts`,
    )
    expect(bounded).toEqual(view)
  })

  it('all off: a clamped SpO2 the screen shows can fire the alert', async () => {
    await withQuality(ALL_OFF)
    const compiled = compileRule(rule('spo2', 'min', 'less_than', 70))
    expect(await fires(compiled.sql, compiled.params)).toBe(true)
  })

  it('one switch at a time: range off shows the 10x value, wear still hides the ambient run', async () => {
    await withQuality({ rangeFilter: false })
    const temps = await column<number>(`SELECT temp_c::DOUBLE AS v FROM v_temperature_clean WHERE user_id = $u ORDER BY ts`)
    expect(temps).toContain(365)
    // 06:00 24 and 06:30 23 stay hidden; 07:00 24 has a heart rate beside it (#482).
    expect(temps).not.toContain(23)
    expect(temps.filter(t => t === 24)).toHaveLength(1)
  })

  it('one switch at a time: spike off keeps the 190, range still drops the 250', async () => {
    await withQuality({ spikeFilter: false })
    const bpm = await column<number>(`SELECT bpm AS v FROM v_heart_rate_clean WHERE user_id = $u`)
    expect(bpm).toContain(190)
    expect(bpm).not.toContain(250)
  })

  it('one switch at a time: wear off keeps the off-wrist SpO2; spike and range still apply', async () => {
    await withQuality({ wearFilter: false })
    const kept = await column<number>(`SELECT spo2 AS v FROM v_spo2_q WHERE user_id = $u AND NOT worn AND clean`)
    expect(kept).toEqual([95])
    const bpm = await column<number>(`SELECT bpm AS v FROM v_heart_rate_clean WHERE user_id = $u`)
    expect(bpm.length).toBeGreaterThan(20)
    expect(bpm).not.toContain(190)
    expect(bpm).not.toContain(250)
    // The 24 °C nightstand temperatures are below the 30 °C clamp too.
    const temps = await column<number>(`SELECT temp_c::DOUBLE AS v FROM v_temperature_clean WHERE user_id = $u`)
    expect(temps).not.toContain(24)
  })

  it('one switch at a time: warm-up off keeps the re-wear onset', async () => {
    await withQuality({ warmUpFilter: false })
    const temps = await column<number>(`SELECT temp_c::DOUBLE AS v FROM v_temperature_clean WHERE user_id = $u ORDER BY ts`)
    expect(temps).toEqual([35, 36, 36, 37, 36, 36, 37])
  })
})
