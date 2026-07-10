/**
 * T-03 + T-04 — Heart rate, SpO2, temperature mappers.
 *
 * All three are straight column-rename + ctx-propagation mappers with no
 * sentinel handling. Compact suite verifying rename + row count + ts parse.
 */

import { describe, expect, it } from 'vitest'

import { mapHeartRate } from '../heart-rate'
import { mapSpo2 } from '../spo2'
import { mapTemperature } from '../temperature'
import type { MapperContext } from '../types'

const ctx: MapperContext = {
  brand: 'ziva',
  familyId: 'fam_test',
  userId: 'user_alice',
  deviceId: 'ring_8047',
  userTimezone: 'America/Los_Angeles',
}

describe('mapHeartRate', () => {
  it('renames singleHR to bpm and propagates ctx', () => {
    const [row] = mapHeartRate(
      [{ timestamp: '2026.06.17 03:15:00', singleHR: 72 }],
      ctx,
    )
    expect(row).toMatchObject({
      brand: 'ziva',
      family_id: 'fam_test',
      user_id: 'user_alice',
      device_id: 'ring_8047',
      bpm: 72,
    })
    expect(row.ts.toISOString()).toBe('2026-06-17T03:15:00.000Z')
  })
})

describe('mapSpo2', () => {
  it('renames automaticSpo2Data to spo2', () => {
    const [row] = mapSpo2(
      [{ timestamp: '2026.06.17 03:15:00', automaticSpo2Data: 97 }],
      ctx,
    )
    expect(row.spo2).toBe(97)
    expect(row.device_id).toBe('ring_8047')
  })
})

describe('mapTemperature', () => {
  it('renames temperature to temp_c and preserves whole-degree value', () => {
    const [row] = mapTemperature(
      [{ timestamp: '2026.06.17 03:15:00', temperature: 37 }],
      ctx,
    )
    expect(row.temp_c).toBe(37)
  })
})
