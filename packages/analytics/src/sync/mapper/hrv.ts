/**
 * HRV mapper (T-02).
 *
 * Firmware `hrv_table` rows carry HRV, stress, and — reused as a physical
 * carrier — BP + vascular aging. The BP + vascular fields are `collected_only`
 * (spec.md §Firmware fidelity preserved / analytics-core §Metric metadata) and
 * we keep them on the `hrv` row so they aren't lost, but sentinel zeros must
 * still be normalised to NULL for downstream queries.
 *
 * Sentinel rules (per `.specifica/features/analytics-sync/spec.md` §Firmware
 * mapper):
 *   - `heartRate === 0` → NULL   (0 bpm is not a valid measurement)
 *   - `systolicBP === 0` → NULL
 *   - `diastolicBP === 0` → NULL
 *   - `vascularAging === 0` → NULL
 *   - `hrv === 0` is *not* a sentinel — firmware genuinely reports 0 when RR
 *     variance is below floor; kept as-is
 *   - `stress === 0` is likewise valid
 */

import type { FirmwareHRVRow, HrvRow, MapperContext } from './types'
import { parseTimestamp } from './time'

export function mapHrv(
  rows: readonly FirmwareHRVRow[],
  ctx: MapperContext,
): HrvRow[] {
  const out: HrvRow[] = []
  for (const row of rows) {
    out.push({
      ts: parseTimestamp(row.timestamp),
      brand: ctx.brand,
      family_id: ctx.familyId,
      user_id: ctx.userId,
      device_id: ctx.deviceId,
      hrv_ms: nullable(row.hrv),
      stress: nullable(row.stress),
      systolic_bp: sentinel(row.systolicBP),
      diastolic_bp: sentinel(row.diastolicBP),
      vascular_aging: sentinel(row.vascularAging),
    })
  }
  return out
}

/**
 * `undefined` → NULL. Zero passes through — used for fields where 0 is a valid
 * observed value (`hrv_ms`, `stress`).
 */
function nullable(v: number | undefined): number | null {
  return v === undefined ? null : v
}

/**
 * Firmware sentinel handling: 0 → NULL, undefined → NULL. Used for fields
 * where 0 cannot represent a valid measurement (BP, vascular aging, HR carrier
 * on the HRV row).
 */
function sentinel(v: number | undefined): number | null {
  if (v === undefined || v === 0)
    return null
  return v
}
