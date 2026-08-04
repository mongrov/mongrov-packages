/**
 * Ring config mapper (T-08).
 *
 * Firmware `ring.automaticMonitoringData[]` describes which metrics the ring
 * currently samples (interval + active hours). We store these as SCD-2-style
 * rows in `device_config`, with `valid_from = now()` and `valid_to = null` on
 * the new insert.
 *
 * Closing prior config (SCD-2 semantics):
 *   The mapper accepts an optional `activePriorConfigs` map keyed by
 *   `data_type` (integer, produced via the translator). For every metric that
 *   shows up in the new firmware snapshot, if a prior config was open, the
 *   mapper emits a `close` entry so the sink can `UPDATE ... SET valid_to =
 *   now()` locally before the INSERT lands, and enqueue the same directive
 *   for the next remote push cycle. Metrics present in the prior map but
 *   absent from the new firmware are left open (the ring is silent on them,
 *   not disabling them).
 *
 * Translation:
 *   The mapper cannot invent `data_type` integers or `start_time`/`end_time`
 *   strings on its own — those are consumer-specific enumerations. Callers
 *   MUST pass a `RingConfigTranslator` in `opts` (see `mapper/types.ts`).
 *   Without a translator the mapper cannot produce a schema-shaped row, so
 *   the option is required — TypeScript enforces this at every call site.
 *
 * The mapper stays pure: no engine access, no clock reads beyond the injected
 * `now` (defaults to `new Date()` for production).
 */

import type {
  DeviceConfigRow,
  FirmwareMonitoringWindow,
  FirmwareRingConfig,
  MapperContext,
  RingConfigTranslator,
} from './types'

export interface RingConfigClose {
  device_id: string
  data_type: number
  valid_to: Date
}

export interface MapRingConfigResult {
  inserts: DeviceConfigRow[]
  closes: RingConfigClose[]
}

export interface MapRingConfigOptions {
  now?: Date
  /** Prior open configs for this device, keyed by `data_type`. */
  activePriorConfigs?: ReadonlyMap<number, DeviceConfigRow>
  /** Required — consumer-provided translation from firmware to schema. */
  translator: RingConfigTranslator
}

export function mapRingConfig(
  fw: FirmwareRingConfig,
  ctx: MapperContext,
  opts: MapRingConfigOptions,
): MapRingConfigResult {
  const now = opts.now ?? new Date()
  const prior = opts.activePriorConfigs ?? new Map<number, DeviceConfigRow>()
  const translator = opts.translator

  const inserts: DeviceConfigRow[] = []
  const closes: RingConfigClose[] = []

  for (const window of fw.automaticMonitoringData ?? []) {
    const dataType = translator.metricToDataType(window.metric)
    inserts.push(toRow(window, ctx, now, dataType, translator))
    if (prior.has(dataType)) {
      closes.push({ device_id: ctx.deviceId, data_type: dataType, valid_to: now })
    }
  }

  return { inserts, closes }
}

function toRow(
  window: FirmwareMonitoringWindow,
  ctx: MapperContext,
  now: Date,
  dataType: number,
  translator: RingConfigTranslator,
): DeviceConfigRow {
  const fields = translator.windowToSchemaFields(window)
  return {
    // No `ts` — device_config's time axis is valid_from / valid_to (SCD-2).
    brand: ctx.brand,
    family_id: ctx.familyId,
    user_id: ctx.userId,
    device_id: ctx.deviceId,
    data_type: dataType,
    interval_minutes: window.interval_minutes,
    start_time: fields.start_time,
    end_time: fields.end_time,
    weeks: fields.weeks,
    valid_from: now,
    valid_to: null,
  }
}
