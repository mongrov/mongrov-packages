/**
 * Re-syncing an unchanged ring schedule is a no-op on `device_config`
 * (principle 66; zivaone_app#673).
 *
 * The handshake reads the schedule on every sync. Every read used to close
 * the open row and insert an identical one, so the table grew by one row per
 * metric per sync, and pushing the same export twice went 3 -> 6 rows. Now an
 * unchanged schedule is a READ: the open row stays the only row and only its
 * `valid_from` moves to the read time, which Auto Monitoring needs to retire
 * a pending change (`overrideRetired`, zivaone_app#662).
 *
 * Runs the ring test pack's ingest adapter against the real DDL on DuckDB, and
 * plays the flusher's part by inserting the rows it returns the way the
 * flusher does (`ON CONFLICT DO NOTHING`, the table carries a primary key).
 */

import type { IngestDeps } from '../../../../core/packs'
import type { DeviceConfigRow, FirmwareExport, FirmwareMonitoringWindow, MapperContext } from '../mapper/types'
import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../../../__integration__/setup/real-engine'
import { createFakeKV } from '../../../../core/__tests__/__fakes__/fake-kv'
import { LOCAL_SCHEMAS } from '../../legacy-tables'
import { parseNaiveUtcTimestamp, READ_DEVICE_CONFIG_SQL, readDeviceConfigParams } from '../config-closes'
import { firmwareIngestAdapter } from '../ingest'
import { mapRingConfig } from '../mapper/ring-config'

const ctx: MapperContext = { brand: 'ziva', familyId: 'fam', userId: 'u1', deviceId: 'ring_1', userTimezone: 'Asia/Kolkata' }
const DAYS = { sunday: true, monday: true, Tuesday: true, Wednesday: true, Thursday: true, Friday: true, Saturday: true }

function win(dataType: number, intervalTime: number, startH = 0, endH = 23): FirmwareMonitoringWindow {
  return { mode: 1, dataType, intervalTime, startTime_Hour: startH, startTime_Minutes: 0, endTime_Hour: endH, endTime_Minutes: 0, weeks: DAYS } as unknown as FirmwareMonitoringWindow
}

function exportWith(windows: FirmwareMonitoringWindow[]): FirmwareExport {
  return { heartrate: [], hrv_table: [], spo2: [], temperature_table: [], activitydetails: [], sleep: [], battery_table: [], ring: { automaticMonitoringData: windows } } as unknown as FirmwareExport
}

const SCHEDULE = [win(4, 5, 22, 8), win(2, 30), win(3, 30)]

const COLS = ['device_id', 'brand', 'family_id', 'user_id', 'metric', 'interval_minutes', 'start_time', 'end_time', 'weeks', 'valid_from', 'valid_to'] as const

async function boot() {
  const db = await createRealDuckDB([])
  await db.execute(LOCAL_SCHEMAS.device_config.replace('CREATE TABLE device_config', 'CREATE TABLE memory.main.device_config'))
  const deps: IngestDeps = {
    execute: (sql, params) => db.execute(sql, params) as never,
    tables: ['device_config'],
    storage: createFakeKV().kv,
    attach: { brand: 'ziva', tenantScope: 'family', tenantId: 'fam', userId: 'u1' } as never,
  }
  /** One sync: ingest, then the flusher's insert of the returned rows. */
  async function sync(fw: FirmwareExport) {
    const out = await firmwareIngestAdapter.ingest(fw, ctx, deps)
    const rows = (out.find(([t]) => t === 'device_config')?.[1] ?? []) as unknown as DeviceConfigRow[]
    for (const r of rows) {
      await db.execute(
        `INSERT INTO memory.main.device_config (${COLS.join(', ')}) VALUES (${COLS.map(c => `$${c}`).join(', ')}) ON CONFLICT DO NOTHING`,
        Object.fromEntries(COLS.map(c => [c, r[c] instanceof Date ? (r[c] as Date).toISOString().replace('T', ' ').replace('Z', '') : r[c]])),
      )
    }
    return rows.length
  }
  interface Row { metric: string, interval_minutes: number, valid_from: string, valid_to: string | null }
  const all = async () => (await db.execute(
    `SELECT metric, interval_minutes, valid_from::VARCHAR AS valid_from, valid_to::VARCHAR AS valid_to
       FROM memory.main.device_config ORDER BY metric, valid_from`,
  )) as unknown as Row[]
  return { db, sync, all }
}

const tick = () => new Promise(r => setTimeout(r, 5))

describe('device_config: an unchanged schedule re-read adds no rows', () => {
  it('the same export pushed three times leaves one open row per metric; only valid_from moves', async () => {
    const { db, sync, all } = await boot()
    try {
      expect(await sync(exportWith(SCHEDULE))).toBe(3)
      const first = await all()
      await tick()
      expect(await sync(exportWith(SCHEDULE))).toBe(0)
      await tick()
      expect(await sync(exportWith(SCHEDULE))).toBe(0)
      const after = await all()
      expect(after).toHaveLength(3)
      expect(after.every(r => r.valid_to === null)).toBe(true)
      expect(after.map(r => [r.metric, r.interval_minutes])).toEqual(first.map(r => [r.metric, r.interval_minutes]))
      // The read time advanced: what Auto Monitoring's override retirement reads.
      for (let i = 0; i < 3; i++)
        expect(after[i]!.valid_from > first[i]!.valid_from).toBe(true)
    }
    finally {
      await db.close()
    }
  })

  it('a changed schedule still versions: close the open row, insert the new one', async () => {
    const { db, sync, all } = await boot()
    try {
      await sync(exportWith(SCHEDULE))
      await tick()
      expect(await sync(exportWith([win(4, 30), win(2, 30), win(3, 30)]))).toBe(1)
      const rows = await all()
      expect(rows).toHaveLength(4)
      const hrv = rows.filter(r => r.metric === 'hrv')
      expect(hrv.map(r => r.interval_minutes)).toEqual([5, 30])
      expect(hrv[0]!.valid_to).toBe(hrv[1]!.valid_from)
      expect(hrv[1]!.valid_to).toBeNull()
    }
    finally {
      await db.close()
    }
  })

  it('duplicate open rows from an older install converge to one on the next read', async () => {
    const { db, sync, all } = await boot()
    try {
      for (const ts of ['2026-09-01 00:00:00', '2026-09-02 00:00:00']) {
        await db.execute(
          `INSERT INTO memory.main.device_config VALUES ('ring_1', 'ziva', 'fam', 'u1', 'spo2', 30, '00:00', '23:00', 127, TIMESTAMP '${ts}', NULL)`,
        )
      }
      await sync(exportWith([win(2, 30)]))
      const open = (await all()).filter(r => r.valid_to === null)
      expect(open).toHaveLength(1)
      await tick()
      await sync(exportWith([win(2, 30)]))
      expect((await all()).filter(r => r.valid_to === null)).toHaveLength(1)
      expect(await all()).toHaveLength(3)
    }
    finally {
      await db.close()
    }
  })

  it('rEAD_DEVICE_CONFIG_SQL matches only the exact open row it was mapped from (replay-safe)', async () => {
    const { db, all } = await boot()
    try {
      await db.execute(
        `INSERT INTO memory.main.device_config VALUES ('ring_1', 'ziva', 'fam', 'u1', 'spo2', 30, NULL, NULL, NULL, TIMESTAMP '2026-09-01 00:00:00.123', NULL)`,
      )
      const read = { device_id: 'ring_1', metric: 'spo2', prior_valid_from: new Date('2026-09-01T00:00:00.123Z'), read_at: new Date('2026-09-05T10:00:00.456Z') }
      await db.execute(READ_DEVICE_CONFIG_SQL, readDeviceConfigParams(read))
      expect((await all())[0]!.valid_from).toBe('2026-09-05 10:00:00.456')
      // Replayed: the row no longer holds prior_valid_from, nothing changes.
      await db.execute(READ_DEVICE_CONFIG_SQL, readDeviceConfigParams({ ...read, read_at: new Date('2026-09-06T00:00:00Z') }))
      expect((await all())[0]!.valid_from).toBe('2026-09-05 10:00:00.456')
    }
    finally {
      await db.close()
    }
  })
})

describe('mapRingConfig: read vs version', () => {
  const NOW = new Date('2026-06-17T12:00:00.000Z')
  const open = (over: Partial<DeviceConfigRow> = {}): DeviceConfigRow => ({
    brand: 'ziva',
    family_id: 'fam',
    user_id: 'u1',
    device_id: 'ring_1',
    metric: 'spo2',
    interval_minutes: 30,
    start_time: '00:00',
    end_time: '23:00',
    weeks: 0x7F,
    valid_from: new Date('2026-06-01T00:00:00Z'),
    valid_to: null,
    ...over,
  })

  it('an older `now` than the open row is not a newer read: nothing at all', () => {
    const r = mapRingConfig({ automaticMonitoringData: [win(2, 30)] }, ctx, { now: new Date('2026-05-01T00:00:00Z'), activePriorConfigs: new Map([['spo2', open()]]) })
    expect(r).toEqual({ inserts: [], closes: [], reads: [] })
  })

  it('two windows for one metric version (never a read), so no key collision can hide one', () => {
    const r = mapRingConfig({ automaticMonitoringData: [win(2, 30), win(2, 30, 1, 2)] }, ctx, { now: NOW, activePriorConfigs: new Map([['spo2', open()]]) })
    expect(r.reads).toEqual([])
    expect(r.inserts).toHaveLength(2)
    expect(r.closes).toHaveLength(1)
  })

  it('accepts the array form fetchActivePriorConfigs builds', () => {
    const r = mapRingConfig({ automaticMonitoringData: [win(2, 30)] }, ctx, { now: NOW, activePriorConfigs: new Map([['spo2', [open()]]]) })
    expect(r.reads).toEqual([{ device_id: 'ring_1', metric: 'spo2', prior_valid_from: open().valid_from, read_at: NOW }])
  })
})

describe('parseNaiveUtcTimestamp: zoneless engine timestamps are UTC', () => {
  it.each([
    ['2026-09-01T10:00:00.123', '2026-09-01T10:00:00.123Z'], // react-native-duckdb
    ['2026-09-01 10:00:00.123456', '2026-09-01T10:00:00.123Z'], // desktop text
    ['2026-09-01 10:00:00', '2026-09-01T10:00:00.000Z'],
    ['2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z'],
  ])('%s', (input, iso) => {
    expect(parseNaiveUtcTimestamp(input).toISOString()).toBe(iso)
  })
})
