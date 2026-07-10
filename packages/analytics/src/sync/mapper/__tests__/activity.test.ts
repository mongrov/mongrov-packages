/**
 * T-05 — Activity mapper (dual output).
 *
 * Coverage:
 *   1. `arraySteps[10]` unnest count matches array length; per-row ts advances
 *      by exactly 1 minute; ctx propagated.
 *   2. `activity_bucket` mirrors the 10-min totals (steps, calories,
 *      distance_km) at the base timestamp.
 *   3. Known 1.3% mismatch: sum(arraySteps) may not equal `step` — mapper
 *      still emits both without erroring; the bucket carries `step` verbatim.
 */

import { describe, expect, it } from 'vitest'

import { mapActivity } from '../activity'
import type { FirmwareActivityRow, MapperContext } from '../types'

const ctx: MapperContext = {
  brand: 'ziva',
  familyId: 'fam_test',
  userId: 'user_alice',
  deviceId: 'ring_8047',
  userTimezone: 'America/Los_Angeles',
}

describe('mapActivity', () => {
  it('unnests arraySteps[10] into ten 1-minute activity rows', () => {
    const fw: FirmwareActivityRow[] = [
      {
        timestamp: '2026.06.17 10:00:00',
        step: 45,
        calories: 5,
        distance: 0.03,
        arraySteps: [4, 5, 4, 5, 4, 5, 4, 5, 4, 5],
      },
    ]
    const { activity, activity_bucket } = mapActivity(fw, ctx)
    expect(activity).toHaveLength(10)
    // Each row 60s apart.
    for (let i = 0; i < 10; i++) {
      expect(activity[i].ts.toISOString()).toBe(
        new Date(Date.UTC(2026, 5, 17, 10, i, 0)).toISOString(),
      )
      expect(activity[i].steps).toBe(fw[0].arraySteps[i])
      expect(activity[i].user_id).toBe('user_alice')
    }
    expect(activity_bucket).toHaveLength(1)
    expect(activity_bucket[0].ts.toISOString()).toBe('2026-06-17T10:00:00.000Z')
    expect(activity_bucket[0]).toMatchObject({
      steps: 45,
      calories: 5,
      distance_km: 0.03,
    })
  })

  it('emits per-row bucket + activity for every input row', () => {
    const fw: FirmwareActivityRow[] = [
      {
        timestamp: '2026.06.17 10:00:00',
        step: 45,
        calories: 5,
        distance: 0.03,
        arraySteps: [4, 5, 4, 5, 4, 5, 4, 5, 4, 5],
      },
      {
        timestamp: '2026.06.17 10:10:00',
        step: 60,
        calories: 7,
        distance: 0.05,
        arraySteps: [6, 6, 6, 6, 6, 6, 6, 6, 6, 6],
      },
    ]
    const { activity, activity_bucket } = mapActivity(fw, ctx)
    expect(activity).toHaveLength(20)
    expect(activity_bucket).toHaveLength(2)
  })

  it('tolerates a mismatch between sum(arraySteps) and step (firmware 1.3% quirk)', () => {
    const fw: FirmwareActivityRow[] = [
      {
        timestamp: '2026.06.17 10:00:00',
        step: 100, // firmware says 100
        calories: 8,
        distance: 0.07,
        arraySteps: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10], // sums to 100
      },
      {
        timestamp: '2026.06.17 10:10:00',
        step: 60, // firmware says 60 but sum below is 55
        calories: 7,
        distance: 0.05,
        arraySteps: [5, 5, 5, 5, 5, 5, 5, 5, 5, 10], // sums to 55, close but not equal
      },
    ]
    // Mapper must not throw. Bucket carries firmware's `step`, activity carries
    // the per-minute breakdown. Downstream tally-by-minute is the ground truth.
    const { activity, activity_bucket } = mapActivity(fw, ctx)
    expect(activity_bucket[0].steps).toBe(100)
    expect(activity_bucket[1].steps).toBe(60)
    const sumFirst = activity.slice(0, 10).reduce((a, r) => a + r.steps, 0)
    const sumSecond = activity.slice(10, 20).reduce((a, r) => a + r.steps, 0)
    expect(sumFirst).toBe(100)
    expect(sumSecond).toBe(55)
  })
})
