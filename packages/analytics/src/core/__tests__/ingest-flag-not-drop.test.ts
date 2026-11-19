/**
 * T-60 acceptance (sprint6 spec §13 amendment 2026-11-12, S10 "flag, don't
 * delete"), end to end through the ingest rule and the real views.
 *
 * Firmware with HR 250 and SpO2 40 goes through the real mapper and
 * `dropMalformedRows` (the rule `sink.push` and `pushFirmware` apply) into real
 * DuckDB, with views from `createViews`, the attach path:
 *   - both rows are stored
 *   - `v_heart_rate_q.plausible` / `v_spo2_q.plausible` are false for them
 *   - `_clean` skips them with `rangeFilter` on and shows them with it off
 *   - a row dated 1970 is dropped and counted
 */
import type { FirmwareExport, MapperContext } from '../../sync/mapper/types'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { mapFirmwareExport } from '../../sync/mapper/firmware'
import { dropMalformedRows, DropTally } from '../../sync/mapper/plausibility'
import { HybridDuckDB } from '../engine'
import { LOCAL_SCHEMAS, TABLE_NAMES } from '../schemas'
import { createViews } from '../warehouse'

const BRAND = 'ziva'
const FAMILY = 'fam_t60'
const USER = 'user_t60'
const ctx: MapperContext = { brand: BRAND, familyId: FAMILY, userId: USER, deviceId: 'ring_t60', userTimezone: 'UTC' }

const fw: FirmwareExport = {
  heartrate: [
    { timestamp: '2026.08.20 07:00:00', singleHR: 60 },
    { timestamp: '2026.08.20 07:10:00', singleHR: 250 },
    { timestamp: '2026.08.20 07:20:00', singleHR: 62 },
    { timestamp: '1970.01.01 00:00:00', singleHR: 61 },
  ],
  spo2: [
    { timestamp: '2026.08.20 07:00:00', automaticSpo2Data: 97 },
    { timestamp: '2026.08.20 07:10:00', automaticSpo2Data: 40 },
  ],
  hrv_table: [],
  temperature_table: [],
  activitydetails: [],
  sleep_processed: [],
  battery_table: [],
  ring: { automaticMonitoringData: [] },
} as unknown as FirmwareExport

let db: HybridDuckDB
const tally = new DropTally()

function toLiteral(value: unknown): string {
  if (value === null || value === undefined)
    return 'NULL'
  if (value instanceof Date)
    return `TIMESTAMP '${value.toISOString().replace('T', ' ').replace('Z', '')}'`
  if (typeof value === 'number')
    return String(value)
  return `'${String(value).replace(/'/g, '\'\'')}'`
}

async function store(table: 'heart_rate' | 'spo2', rows: readonly object[]): Promise<void> {
  const report = dropMalformedRows(table, rows as Record<string, unknown>[], new Date('2026-08-21T00:00:00Z'))
  tally.add(table, report)
  for (const row of report.kept) {
    const cols = Object.keys(row)
    await db.execute(
      `INSERT INTO memory.${table} (${cols.join(', ')}) VALUES (${cols.map(c => toLiteral(row[c])).join(', ')})`,
    )
  }
}

async function column<T>(sql: string): Promise<T[]> {
  return (await db.execute<{ v: T }>(sql, { u: USER })).map(r => r.v)
}

async function withRangeFilter(rangeFilter: boolean): Promise<void> {
  await createViews(db, { brand: BRAND, familyId: FAMILY, localCatalog: 'memory', quality: { rangeFilter, spikeFilter: false } })
}

beforeAll(async () => {
  db = new HybridDuckDB(() => createRealDuckDB(['icu']))
  await db.open()
  for (const t of TABLE_NAMES) await db.execute(LOCAL_SCHEMAS[t])
  const batch = mapFirmwareExport(fw, ctx, { now: new Date('2026-08-21T00:00:00Z') })
  await store('heart_rate', batch.heart_rate)
  await store('spo2', batch.spo2)
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('t-60: out-of-range readings are stored and flagged, not dropped', () => {
  it('stores HR 250 and SpO2 40', async () => {
    expect(await column<number>(`SELECT bpm AS v FROM memory.heart_rate WHERE user_id = $u ORDER BY ts`)).toEqual([60, 250, 62])
    expect(await column<number>(`SELECT spo2 AS v FROM memory.spo2 WHERE user_id = $u ORDER BY ts`)).toEqual([97, 40])
  })

  it('flags them plausible = false in v_*_q', async () => {
    await withRangeFilter(true)
    expect(await column<number>(`SELECT bpm AS v FROM v_heart_rate_q WHERE user_id = $u AND NOT plausible`)).toEqual([250])
    expect(await column<number>(`SELECT spo2 AS v FROM v_spo2_q WHERE user_id = $u AND NOT plausible`)).toEqual([40])
  })

  it('_clean skips them with rangeFilter on', async () => {
    await withRangeFilter(true)
    expect(await column<number>(`SELECT bpm AS v FROM v_heart_rate_clean WHERE user_id = $u ORDER BY ts`)).toEqual([60, 62])
    expect(await column<number>(`SELECT spo2 AS v FROM v_spo2_clean WHERE user_id = $u ORDER BY ts`)).toEqual([97])
  })

  it('_clean shows them with rangeFilter off', async () => {
    await withRangeFilter(false)
    expect(await column<number>(`SELECT bpm AS v FROM v_heart_rate_clean WHERE user_id = $u ORDER BY ts`)).toEqual([60, 250, 62])
    expect(await column<number>(`SELECT spo2 AS v FROM v_spo2_clean WHERE user_id = $u ORDER BY ts`)).toEqual([97, 40])
  })

  it('drops the 1970 row and counts it', async () => {
    expect(await column<number>(`SELECT count(*)::INTEGER AS v FROM memory.heart_rate WHERE ts < TIMESTAMP '2020-01-01' AND user_id = $u`)).toEqual([0])
    expect(tally.drain()).toEqual(expect.objectContaining({
      total: 1,
      dropped: { heart_rate: { before_epoch: 1 } },
    }))
  })
})
