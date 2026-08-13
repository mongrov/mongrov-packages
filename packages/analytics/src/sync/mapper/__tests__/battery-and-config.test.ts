/**
 * T-07 (battery) + T-08 (ring config).
 *
 * Battery coverage:
 *   1. Each row → device_battery with a numeric battery_pct column
 *      (0.6.0 fix B2 — previously a device_event JSON payload the rules
 *      compiler could not aggregate).
 *
 * Ring config coverage:
 *   1. First install (no prior configs): every automaticMonitoringData entry
 *      becomes an insert with valid_from = now, valid_to = null; no closes.
 *   2. Config change: metric present in both prior and new → one insert +
 *      one close entry keyed on `(device_id, metric)`.
 *   3. The mapper itself translates the vendor struct — firmware `dataType`
 *      becomes our metric id, split hour/minute fields become HH:MM, and
 *      the seven-boolean `weeks` struct becomes a bitmask. No firmware
 *      integer reaches the schema (principle 21).
 */

import type {
  DeviceConfigRow,
  FirmwareBatteryRow,
  FirmwareRingConfig,
  FirmwareWeekdays,
  MapperContext,
} from '../types'

import { describe, expect, it } from 'vitest'
import { mapBattery } from '../battery'
import { mapRingConfig } from '../ring-config'

const ctx: MapperContext = {
  brand: 'ziva',
  familyId: 'fam_test',
  userId: 'user_alice',
  deviceId: 'ring_8047',
  userTimezone: 'America/Los_Angeles',
}

const ALL_DAYS: FirmwareWeekdays = {
  sunday: true,
  monday: true,
  Tuesday: true,
  Wednesday: true,
  Thursday: true,
  Friday: true,
  Saturday: true,
}

/** One vendor-shaped monitoring window (AutomaticMonitoring_J2301A). */
function window(dataType: number, intervalTime: number, sh: number, eh: number) {
  return {
    dataType,
    intervalTime,
    startTime_Hour: sh,
    startTime_Minutes: 0,
    endTime_Hour: eh,
    endTime_Minutes: 0,
    weeks: { ...ALL_DAYS },
    mode: 1,
  }
}

describe('mapBattery', () => {
  it('emits device_battery rows with numeric battery_pct', () => {
    const fw: FirmwareBatteryRow[] = [
      { timestamp: '2026.06.17 03:15:00', battery: 82 },
      { timestamp: '2026.06.17 04:15:00', battery: 79 },
    ]
    const rows = mapBattery(fw, ctx)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.device_id).toBe('ring_8047')
      expect(typeof row.battery_pct).toBe('number')
    }
    expect(rows[0].battery_pct).toBe(82)
    expect(rows[1].battery_pct).toBe(79)
  })
})

describe('mapRingConfig', () => {
  const NOW = new Date('2026-06-17T12:00:00.000Z')
  const fw: FirmwareRingConfig = {
    automaticMonitoringData: [
      window(4, 5, 22, 8), // HRV
      window(2, 30, 0, 23), // SpO2
    ],
  }

  it('first install: emits inserts only, no closes', () => {
    const { inserts, closes } = mapRingConfig(fw, ctx, { now: NOW })
    expect(inserts).toHaveLength(2)
    expect(closes).toHaveLength(0)
    for (const row of inserts) {
      expect(row.valid_from.toISOString()).toBe(NOW.toISOString())
      expect(row.valid_to).toBeNull()
    }
    // Translator produced the schema-shaped integers + strings.
    expect(inserts.map(r => r.metric)).toEqual(['hrv', 'spo2'])
    expect(inserts[0].start_time).toBe('22:00')
    expect(inserts[0].end_time).toBe('08:00')
    expect(inserts[0].interval_minutes).toBe(5)
    expect(inserts[0].weeks).toBe(0x7F)
    expect(inserts[1].start_time).toBe('00:00')
    expect(inserts[1].end_time).toBe('23:00')
  })

  it('emits a close entry keyed on (device_id, metric) for each metric with a prior open config', () => {
    const priorHrv: DeviceConfigRow = {
      brand: ctx.brand,
      family_id: ctx.familyId,
      user_id: ctx.userId,
      device_id: ctx.deviceId,
      metric: 'hrv',
      interval_minutes: 10,
      start_time: '22:00',
      end_time: '08:00',
      weeks: 0x7F,
      valid_from: new Date('2026-06-01T00:00:00.000Z'),
      valid_to: null,
    }
    const activePrior = new Map<string, DeviceConfigRow>([['hrv', priorHrv]])
    const { inserts, closes } = mapRingConfig(fw, ctx, {
      now: NOW,
      activePriorConfigs: activePrior,
    })
    expect(inserts).toHaveLength(2)
    expect(closes).toEqual([
      { device_id: 'ring_8047', metric: 'hrv', valid_to: NOW },
    ])
  })
})
