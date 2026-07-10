/**
 * Battery mapper (T-07).
 *
 * Firmware `battery_table` rows lift into the generic `device_event` stream
 * with `event_type='battery_sample'`. The battery level lives in the JSON
 * payload column so the `device_event` table doesn't grow bespoke columns
 * for every metric variant.
 */

import { parseTimestamp } from './time'
import type {
  DeviceEventRow,
  FirmwareBatteryRow,
  MapperContext,
} from './types'

export const BATTERY_EVENT = 'battery_sample'

export function mapBattery(
  rows: readonly FirmwareBatteryRow[],
  ctx: MapperContext,
): DeviceEventRow[] {
  return rows.map(row => ({
    ts: parseTimestamp(row.timestamp),
    brand: ctx.brand,
    family_id: ctx.familyId,
    user_id: ctx.userId,
    device_id: ctx.deviceId,
    event_type: BATTERY_EVENT,
    payload: { battery: row.battery },
  }))
}
