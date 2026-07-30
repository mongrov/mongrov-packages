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
 *      one close entry keyed on `(device_id, data_type)`.
 *   3. Translator drives `data_type` + `start_time`/`end_time`/`weeks`
 *      derivation — the mapper never invents schema-specific integers or
 *      strings.
 */

import { describe, expect, it } from 'vitest'

import { mapBattery } from '../battery'
import { mapRingConfig } from '../ring-config'
import type {
  DeviceConfigRow,
  FirmwareBatteryRow,
  FirmwareRingConfig,
  MapperContext,
  RingConfigTranslator,
} from '../types'

const ctx: MapperContext = {
  brand: 'ziva',
  familyId: 'fam_test',
  userId: 'user_alice',
  deviceId: 'ring_8047',
  userTimezone: 'America/Los_Angeles',
}

// Minimal test translator: fixed metric ↔ data_type map + naive HH:00 → HH:MM
// window rendering with a static all-days weeks bitmask (0x7F = 0b1111111).
const METRIC_ENUM: Record<string, number> = { hrv: 1, spo2: 2, heart_rate: 3 }
const ENUM_METRIC: Record<number, string> = { 1: 'hrv', 2: 'spo2', 3: 'heart_rate' }
const translator: RingConfigTranslator = {
  metricToDataType: metric => METRIC_ENUM[metric] ?? 99,
  dataTypeToMetric: dataType => ENUM_METRIC[dataType] ?? 'unknown',
  windowToSchemaFields: w => ({
    start_time: `${String(w.start_hour).padStart(2, '0')}:00`,
    end_time: `${String(w.end_hour).padStart(2, '0')}:00`,
    weeks: 0x7F,
  }),
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
      { metric: 'hrv', interval_minutes: 5, start_hour: 22, end_hour: 8 },
      { metric: 'spo2', interval_minutes: 30, start_hour: 0, end_hour: 23 },
    ],
  }

  it('first install: emits inserts only, no closes', () => {
    const { inserts, closes } = mapRingConfig(fw, ctx, { now: NOW, translator })
    expect(inserts).toHaveLength(2)
    expect(closes).toHaveLength(0)
    for (const row of inserts) {
      expect(row.valid_from.toISOString()).toBe(NOW.toISOString())
      expect(row.valid_to).toBeNull()
    }
    // Translator produced the schema-shaped integers + strings.
    expect(inserts.map(r => r.data_type)).toEqual([1, 2])
    expect(inserts[0].start_time).toBe('22:00')
    expect(inserts[0].end_time).toBe('08:00')
    expect(inserts[0].interval_minutes).toBe(5)
    expect(inserts[0].weeks).toBe(0x7F)
    expect(inserts[1].start_time).toBe('00:00')
    expect(inserts[1].end_time).toBe('23:00')
  })

  it('emits a close entry keyed on (device_id, data_type) for each metric with a prior open config', () => {
    const priorHrv: DeviceConfigRow = {
      ts: new Date('2026-06-01T00:00:00.000Z'),
      brand: ctx.brand,
      family_id: ctx.familyId,
      user_id: ctx.userId,
      device_id: ctx.deviceId,
      data_type: 1,
      interval_minutes: 10,
      start_time: '22:00',
      end_time: '08:00',
      weeks: 0x7F,
      valid_from: new Date('2026-06-01T00:00:00.000Z'),
      valid_to: null,
    }
    const activePrior = new Map<number, DeviceConfigRow>([[1, priorHrv]])
    const { inserts, closes } = mapRingConfig(fw, ctx, {
      now: NOW,
      activePriorConfigs: activePrior,
      translator,
    })
    expect(inserts).toHaveLength(2)
    expect(closes).toEqual([
      { device_id: 'ring_8047', data_type: 1, valid_to: NOW },
    ])
  })
})
