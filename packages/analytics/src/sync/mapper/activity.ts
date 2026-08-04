/**
 * Activity mapper (T-05).
 *
 * Firmware `activitydetails` rows aggregate 10 minutes of steps in
 * `arraySteps[10]` alongside a 10-minute bucket `step` (total), `calories`,
 * and `distance` (km). We want both granularities in the warehouse:
 *
 *   - `activity`         — 1-min rows via `arraySteps` unnest
 *   - `activity_bucket`  — 10-min rows preserving calories + distance
 *
 * Timestamp policy: the firmware `timestamp` marks the start of the 10-min
 * block. Each unnested activity row is stamped at `base + i minutes` where
 * `i` is the index into `arraySteps`.
 *
 * Known 1.3% mismatch: sum(arraySteps) can drift from `step` (firmware
 * quirk). Spec calls for "flag in log" — deferred until the SyncLogger wire
 * lands in Phase C. For now the mapper produces both outputs and the ground
 * truth in the warehouse is the sum of `activity.steps` per user per
 * 10-minute window.
 *
 * Distance unit: firmware `distance` is passed through as-is into
 * `distance_km`. If field measurement shows the firmware reports metres, this
 * mapper is the single place to divide.
 */

import { parseTimestamp } from './time'
import type {
  ActivityBucketRow,
  ActivityRow,
  FirmwareActivityRow,
  MapperContext,
} from './types'

export interface MapActivityResult {
  activity: ActivityRow[]
  activity_bucket: ActivityBucketRow[]
}

const MINUTE_MS = 60_000

export function mapActivity(
  rows: readonly FirmwareActivityRow[],
  ctx: MapperContext,
): MapActivityResult {
  const activity: ActivityRow[] = []
  const activity_bucket: ActivityBucketRow[] = []

  for (const row of rows) {
    const baseTs = parseTimestamp(row.timestamp)
    const steps = row.arraySteps ?? []
    for (let i = 0; i < steps.length; i++) {
      activity.push({
        ts: new Date(baseTs.getTime() + i * MINUTE_MS),
        brand: ctx.brand,
        family_id: ctx.familyId,
        user_id: ctx.userId,
        device_id: ctx.deviceId,
        steps: steps[i],
      })
    }
    activity_bucket.push({
      ts: baseTs,
      brand: ctx.brand,
      family_id: ctx.familyId,
      user_id: ctx.userId,
      device_id: ctx.deviceId,
      // No `steps` — the bucket carries calories/distance only. Steps are
      // unnested to 1-min `activity` rows above (spec §Table schema).
      calories: row.calories,
      distance_km: row.distance,
    })
  }

  return { activity, activity_bucket }
}
