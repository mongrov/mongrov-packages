/**
 * Firmware composition mapper (T-09).
 *
 * Invokes every sub-mapper and produces a `MappedBatch` in one call. Empty
 * firmware sections (undefined / empty array / absent `ring`) resolve to
 * empty output arrays — no throw.
 *
 * The composition module owns the two SCD-2 outputs (device_config inserts
 * vs. device_config closes). For flushing, callers use:
 *   - `batch.device_config` — new inserts
 *   - `batch.device_config_closes` — SCD-2 close directives
 *
 * See `.specifica/features/analytics-sync/spec.md` §Firmware mapper for the
 * shape contract.
 */

import { mapActivity } from './activity'
import { mapBattery } from './battery'
import { mapHeartRate } from './heart-rate'
import { mapHrv } from './hrv'
import { mapRingConfig, type RingConfigClose } from './ring-config'
import { reconstructSleepSessions } from './sleep'
import { mapSpo2 } from './spo2'
import { mapTemperature } from './temperature'
import type {
  DeviceConfigRow,
  FirmwareExport,
  MappedBatch,
  MapperContext,
} from './types'

export interface MapFirmwareOptions {
  /** Override for deterministic tests. Defaults to `new Date()`. */
  now?: Date
  /** SCD-2 prior-config map — see `mapRingConfig`. */
  activePriorConfigs?: ReadonlyMap<string, DeviceConfigRow>
}

export interface FirmwareMappedBatch extends MappedBatch {
  device_config_closes: RingConfigClose[]
}

export function mapFirmwareExport(
  fw: FirmwareExport,
  ctx: MapperContext,
  opts: MapFirmwareOptions = {},
): FirmwareMappedBatch {
  const activity = mapActivity(fw.activitydetails ?? [], ctx)
  const sleep = reconstructSleepSessions(fw.sleep_processed ?? [], ctx)
  const config = mapRingConfig(
    fw.ring ?? { automaticMonitoringData: [] },
    ctx,
    opts,
  )

  return {
    hrv: mapHrv(fw.hrv_table ?? [], ctx),
    heart_rate: mapHeartRate(fw.heartrate ?? [], ctx),
    spo2: mapSpo2(fw.spo2 ?? [], ctx),
    temperature: mapTemperature(fw.temperature_table ?? [], ctx),
    activity: activity.activity,
    activity_bucket: activity.activity_bucket,
    sleep_session: sleep.sleep_session,
    sleep_stage: sleep.sleep_stage,
    sleep_raw: sleep.sleep_raw,
    device_event: mapBattery(fw.battery_table ?? [], ctx),
    device_config: config.inserts,
    device_config_closes: config.closes,
  }
}
