/**
 * Ring config mapper (T-08).
 *
 * Firmware `ring.automaticMonitoringData[]` describes which metrics the ring
 * currently samples (interval + active hours). We store these as SCD-2-style
 * rows in `device_config`, with `valid_from = now()` and `valid_to = null` on
 * the new insert.
 *
 * Closing prior config (SCD-2 semantics):
 *   The mapper accepts an optional `activePriorConfigs` map keyed by metric
 *   name. For every metric that shows up in the new firmware snapshot, if a
 *   prior config was open, the mapper emits a `close` entry so the flusher
 *   can `UPDATE ... SET valid_to = now()` before the INSERT lands. Metrics
 *   present in the prior map but absent from the new firmware are left open
 *   (the ring is silent on them, not disabling them).
 *
 * The mapper stays pure: no engine access, no clock reads beyond the
 * injected `now` (defaults to `new Date()` for production).
 */

import type {
  DeviceConfigRow,
  FirmwareMonitoringWindow,
  FirmwareRingConfig,
  MapperContext,
} from './types'

export interface RingConfigClose {
  metric: string
  valid_to: Date
}

export interface MapRingConfigResult {
  inserts: DeviceConfigRow[]
  closes: RingConfigClose[]
}

export function mapRingConfig(
  fw: FirmwareRingConfig,
  ctx: MapperContext,
  opts: {
    now?: Date
    activePriorConfigs?: ReadonlyMap<string, DeviceConfigRow>
  } = {},
): MapRingConfigResult {
  const now = opts.now ?? new Date()
  const prior = opts.activePriorConfigs ?? new Map<string, DeviceConfigRow>()

  const inserts: DeviceConfigRow[] = []
  const closes: RingConfigClose[] = []

  for (const window of fw.automaticMonitoringData ?? []) {
    inserts.push(toRow(window, ctx, now))
    if (prior.has(window.metric)) {
      closes.push({ metric: window.metric, valid_to: now })
    }
  }

  return { inserts, closes }
}

function toRow(
  window: FirmwareMonitoringWindow,
  ctx: MapperContext,
  now: Date,
): DeviceConfigRow {
  return {
    ts: now,
    brand: ctx.brand,
    family_id: ctx.familyId,
    user_id: ctx.userId,
    device_id: ctx.deviceId,
    metric: window.metric,
    interval_minutes: window.interval_minutes,
    start_hour: window.start_hour,
    end_hour: window.end_hour,
    valid_from: now,
    valid_to: null,
  }
}
