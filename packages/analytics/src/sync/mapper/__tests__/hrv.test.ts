/**
 * T-02 — HRV mapper.
 *
 * Coverage:
 *   1. Normal row: fields renamed, ctx propagated, ts parsed.
 *   2. Sentinel zeros on BP + vascular aging → NULL.
 *   3. Real zero on hrv/stress stays as 0 (not sentinel).
 */

import type { FirmwareHRVRow, MapperContext } from '../types'

import { describe, expect, it } from 'vitest'
import { mapHrv } from '../hrv'

const ctx: MapperContext = {
  brand: 'ziva',
  familyId: 'fam_test',
  userId: 'user_alice',
  deviceId: 'ring_8047',
  userTimezone: 'America/Los_Angeles',
}

describe('mapHrv', () => {
  it('maps a fully-populated row to the warehouse shape', () => {
    const fw: FirmwareHRVRow[] = [
      {
        timestamp: '2026.06.17 03:15:00',
        hrv: 42,
        stress: 30,
        heartRate: 68,
        systolicBP: 118,
        diastolicBP: 76,
        vascularAging: 33,
      },
    ]
    const rows = mapHrv(fw, ctx)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      brand: 'ziva',
      family_id: 'fam_test',
      user_id: 'user_alice',
      device_id: 'ring_8047',
      hrv_ms: 42,
      stress: 30,
      systolic_bp: 118,
      diastolic_bp: 76,
      vascular_aging: 33,
    })
    expect(rows[0].ts.toISOString()).toBe('2026-06-17T03:15:00.000Z')
  })

  it('coerces sentinel zeros on BP + vascular aging to NULL', () => {
    const fw: FirmwareHRVRow[] = [
      {
        timestamp: '2026.06.17 03:15:00',
        hrv: 42,
        stress: 30,
        heartRate: 0,
        systolicBP: 0,
        diastolicBP: 0,
        vascularAging: 0,
      },
    ]
    const [row] = mapHrv(fw, ctx)
    expect(row.systolic_bp).toBeNull()
    expect(row.diastolic_bp).toBeNull()
    expect(row.vascular_aging).toBeNull()
    // hrv 42 is preserved (not a sentinel field).
    expect(row.hrv_ms).toBe(42)
  })

  it('preserves 0 on hrv_ms / stress (not sentinel fields)', () => {
    const fw: FirmwareHRVRow[] = [
      {
        timestamp: '2026.06.17 03:15:00',
        hrv: 0,
        stress: 0,
      },
    ]
    const [row] = mapHrv(fw, ctx)
    expect(row.hrv_ms).toBe(0)
    expect(row.stress).toBe(0)
    // Absent optional fields → NULL.
    expect(row.systolic_bp).toBeNull()
    expect(row.vascular_aging).toBeNull()
  })
})
