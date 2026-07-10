/**
 * T-07 (battery) + T-08 (ring config).
 *
 * Battery coverage:
 *   1. Each row → device_event(event_type='battery_sample') with battery
 *      level nested in payload.
 *
 * Ring config coverage:
 *   1. First install (no prior configs): every automaticMonitoringData entry
 *      becomes an insert with valid_from = now, valid_to = null; no closes.
 *   2. Config change: metric present in both prior and new → one insert +
 *      one close entry keyed on that metric.
 */

import { describe, expect, it } from 'vitest'

import { BATTERY_EVENT, mapBattery } from '../battery'
import { mapRingConfig } from '../ring-config'
import type {
  DeviceConfigRow,
  FirmwareBatteryRow,
  FirmwareRingConfig,
  MapperContext,
} from '../types'

const ctx: MapperContext = {
  brand: 'ziva',
  familyId: 'fam_test',
  userId: 'user_alice',
  deviceId: 'ring_8047',
  userTimezone: 'America/Los_Angeles',
}

describe('mapBattery', () => {
  it('emits a battery_sample device_event with level in payload', () => {
    const fw: FirmwareBatteryRow[] = [
      { timestamp: '2026.06.17 03:15:00', battery: 82 },
      { timestamp: '2026.06.17 04:15:00', battery: 79 },
    ]
    const rows = mapBattery(fw, ctx)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.event_type).toBe(BATTERY_EVENT)
      expect(row.device_id).toBe('ring_8047')
    }
    expect(rows[0].payload).toEqual({ battery: 82 })
    expect(rows[1].payload).toEqual({ battery: 79 })
  })
})

describe('mapRingConfig', () => {
  const NOW = new Date('2026-06-17T12:00:00.000Z')
  const fw: FirmwareRingConfig = {
    automaticMonitoringData: [
      { metric: 'hrv', interval_minutes: 5, start_hour: 22, end_hour: 8 },
      { metric: 'spo2', interval_minutes: 30, start_hour: 0, end_hour: 23 },
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
    expect(inserts.map(r => r.metric)).toEqual(['hrv', 'spo2'])
  })

  it('emits a close entry for each metric that had a prior active config', () => {
    const priorHrv: DeviceConfigRow = {
      ts: new Date('2026-06-01T00:00:00.000Z'),
      brand: ctx.brand,
      family_id: ctx.familyId,
      user_id: ctx.userId,
      device_id: ctx.deviceId,
      metric: 'hrv',
      interval_minutes: 10,
      start_hour: 22,
      end_hour: 8,
      valid_from: new Date('2026-06-01T00:00:00.000Z'),
      valid_to: null,
    }
    const activePrior = new Map<string, DeviceConfigRow>([['hrv', priorHrv]])
    const { inserts, closes } = mapRingConfig(fw, ctx, {
      now: NOW,
      activePriorConfigs: activePrior,
    })
    expect(inserts).toHaveLength(2)
    expect(closes).toEqual([{ metric: 'hrv', valid_to: NOW }])
  })
})
