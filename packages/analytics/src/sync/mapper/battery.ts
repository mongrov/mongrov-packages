/**
 * Battery mapper (T-07; reworked in 0.6.0 — fix B2).
 *
 * Firmware `battery_table` rows map into the dedicated `device_battery`
 * table with a numeric `battery_pct` column. Pre-0.6.0 they were lifted
 * into the generic `device_event` stream as `event_type='battery_sample'`
 * with the level inside the JSON payload — which the rules compiler
 * could not aggregate numerically, so the LuminX battery rules never
 * fired against real data.
 */

import { parseTimestamp } from './time'
import type {
  DeviceBatteryRow,
  FirmwareBatteryRow,
  MapperContext,
} from './types'

/**
 * @deprecated Battery samples no longer emit `device_event` rows as of
 * 0.6.0 — they land in `device_battery`. Kept only so historical
 * `device_event` rows written by ≤0.5.x can still be filtered by name.
 */
export const BATTERY_EVENT = 'battery_sample'

export function mapBattery(
  rows: readonly FirmwareBatteryRow[],
  ctx: MapperContext,
): DeviceBatteryRow[] {
  return rows.map(row => ({
    ts: parseTimestamp(row.timestamp),
    brand: ctx.brand,
    family_id: ctx.familyId,
    user_id: ctx.userId,
    device_id: ctx.deviceId,
    battery_pct: row.battery,
  }))
}
