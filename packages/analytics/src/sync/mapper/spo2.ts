/**
 * SpO2 mapper (T-04).
 *
 * Column rename: `automaticSpo2Data` → `spo2`. No sentinel handling — firmware
 * omits invalid reads. Values are integer percentages, 0..100.
 */

import type { FirmwareSpO2Row, MapperContext, Spo2Row } from './types'
import { parseTimestamp } from './time'

export function mapSpo2(
  rows: readonly FirmwareSpO2Row[],
  ctx: MapperContext,
): Spo2Row[] {
  return rows.map(row => ({
    ts: parseTimestamp(row.timestamp),
    brand: ctx.brand,
    family_id: ctx.familyId,
    user_id: ctx.userId,
    device_id: ctx.deviceId,
    spo2: row.automaticSpo2Data,
  }))
}
