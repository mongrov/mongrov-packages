/**
 * Temperature mapper (T-04).
 *
 * Column rename: `temperature` → `temp_c`. Firmware emits whole-degree
 * Celsius (limitation of the ring); we preserve as-is — downstream aggregation
 * (e.g. daily average) is expected to smooth the discretisation.
 */

import type { FirmwareTempRow, MapperContext, TemperatureRow } from './types'
import { parseTimestamp } from './time'

export function mapTemperature(
  rows: readonly FirmwareTempRow[],
  ctx: MapperContext,
): TemperatureRow[] {
  return rows.map(row => ({
    ts: parseTimestamp(row.timestamp),
    brand: ctx.brand,
    family_id: ctx.familyId,
    user_id: ctx.userId,
    device_id: ctx.deviceId,
    temp_c: row.temperature,
  }))
}
