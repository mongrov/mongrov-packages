/**
 * Heart-rate mapper (T-03).
 *
 * Firmware column rename: `singleHR` → `bpm`. No sentinel handling: the ring
 * firmware simply omits rows when it has no valid reading, so any row that
 * makes it here is a valid measurement.
 */

import { parseTimestamp } from './time'
import type { FirmwareHRRow, HeartRateRow, MapperContext } from './types'

export function mapHeartRate(
  rows: readonly FirmwareHRRow[],
  ctx: MapperContext,
): HeartRateRow[] {
  return rows.map(row => ({
    ts: parseTimestamp(row.timestamp),
    brand: ctx.brand,
    family_id: ctx.familyId,
    user_id: ctx.userId,
    device_id: ctx.deviceId,
    bpm: row.singleHR,
  }))
}
