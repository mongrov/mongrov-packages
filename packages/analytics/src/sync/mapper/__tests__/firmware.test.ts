/**
 * T-09 — Firmware composition mapper.
 *
 * Coverage:
 *   1. Full fixture at `./fixtures/firmware-8047-17-06-2026.json`
 *      (originally sourced from the workspace-level
 *      `.specifica/fixtures/`; co-located here so the package is
 *      self-contained on CI checkouts that don't include the sibling
 *      `.specifica/` tree).
 *      → MappedBatch with expected row counts per table.
 *   2. Empty firmware (every array absent) → MappedBatch with empty arrays,
 *      no throws, `device_config_closes` empty.
 */

import type { FirmwareExport, MapperContext } from '../types'
import { readFileSync } from 'node:fs'

import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { mapFirmwareExport } from '../firmware'

const ctx: MapperContext = {
  brand: 'ziva',
  familyId: 'fam_test',
  userId: 'user_alice',
  deviceId: 'ring_8047',
  userTimezone: 'America/Los_Angeles',
}

const FIXTURE_PATH = join(
  __dirname,
  'fixtures/firmware-8047-17-06-2026.json',
)
const NOW = new Date('2026-06-17T12:00:00.000Z')

describe('mapFirmwareExport', () => {
  it('produces the expected MappedBatch shape from the full fixture', () => {
    const fw: FirmwareExport = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))
    const batch = mapFirmwareExport(fw, ctx, { now: NOW })

    // Row-count assertions per table.
    expect(batch.heart_rate).toHaveLength(2)
    expect(batch.hrv).toHaveLength(2)
    expect(batch.spo2).toHaveLength(2)
    expect(batch.temperature).toHaveLength(2)
    // 2 activity rows × 10 unnested minutes.
    expect(batch.activity).toHaveLength(20)
    expect(batch.activity_bucket).toHaveLength(2)
    // Only one qualifying primary session; the 14:00 nap is dropped.
    expect(batch.sleep_session).toHaveLength(1)
    // 1 stage block under the qualifying session — the `primary` block is
    // the session envelope, not a stage (DDL stage enum has no code for it).
    expect(batch.sleep_stage).toHaveLength(1)
    // Every input sleep row lives in raw.
    expect(batch.sleep_raw).toHaveLength(3)
    // 2 battery samples → device_battery (0.6.0 fix B2); the generic
    // event stream stays empty until another event type populates it.
    expect(batch.device_battery).toHaveLength(2)
    expect(batch.device_battery[0].battery_pct).toBe(82)
    expect(batch.device_event).toHaveLength(0)
    // 3 monitoring windows (hrv / spo2 / temperature) → 3 device_config
    // rows, one per metric. dataType is 1:1 with metric — no fan-out.
    expect(batch.device_config).toHaveLength(3)
    expect(batch.device_config.map(r => r.metric).sort())
      .toEqual(['hrv', 'spo2', 'temperature'])
    // First-install: no prior configs → no closes.
    expect(batch.device_config_closes).toHaveLength(0)

    // Sentinel handling verified on the second HRV row.
    expect(batch.hrv[1].systolic_bp).toBeNull()
    expect(batch.hrv[1].vascular_aging).toBeNull()
    expect(batch.hrv[1].hrv_ms).toBe(45)

    // Sleep session id shape (principle 25: nanoid(24) + '_' + fnv1a32hex)
    // + night_of correctness.
    expect(batch.sleep_session[0].session_id).toMatch(
      // 8 hex chars, no random prefix (principle 25, amended 2026-08-14).
      /^[0-9a-f]{8}$/,
    )
    // 2026-06-18 05:00 UTC = 2026-06-17 22:00 LA → night_of = 2026-06-17.
    expect(batch.sleep_session[0].night_of.toISOString()).toBe(
      '2026-06-17T07:00:00.000Z',
    )
  })

  it('tolerates a fully empty firmware payload', () => {
    const empty: FirmwareExport = {
      heartrate: [],
      hrv_table: [],
      spo2: [],
      temperature_table: [],
      activitydetails: [],
      sleep_processed: [],
      battery_table: [],
      ring: { automaticMonitoringData: [] },
    }
    const batch = mapFirmwareExport(empty, ctx, { now: NOW })
    expect(batch.heart_rate).toEqual([])
    expect(batch.hrv).toEqual([])
    expect(batch.spo2).toEqual([])
    expect(batch.temperature).toEqual([])
    expect(batch.activity).toEqual([])
    expect(batch.activity_bucket).toEqual([])
    expect(batch.sleep_session).toEqual([])
    expect(batch.sleep_stage).toEqual([])
    expect(batch.sleep_raw).toEqual([])
    expect(batch.device_event).toEqual([])
    expect(batch.device_config).toEqual([])
    expect(batch.device_config_closes).toEqual([])
  })
})
