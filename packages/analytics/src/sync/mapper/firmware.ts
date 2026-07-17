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
  RingConfigTranslator,
} from './types'

export interface MapFirmwareOptions {
  /** Override for deterministic tests. Defaults to `new Date()`. */
  now?: Date
  /**
   * SCD-2 prior-config map keyed by `data_type` (integer) — see
   * `mapRingConfig`. Required whenever `fw.ring` is non-empty; the mapper
   * skips ring-config translation entirely when this is absent and `fw.ring`
   * has no windows.
   */
  activePriorConfigs?: ReadonlyMap<number, DeviceConfigRow>
  /**
   * Consumer-provided translation from firmware ring metrics to schema
   * fields. Required if `fw.ring.automaticMonitoringData` has entries;
   * skipped (empty inserts + closes) if absent.
   */
  translator?: RingConfigTranslator
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
  const config = mapRingConfigIfPossible(fw, ctx, opts)

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

/**
 * Guard around `mapRingConfig`. When the firmware has no ring windows and no
 * translator is supplied, we short-circuit to an empty result rather than
 * threading a required-translator error through every synthetic firmware
 * call site that doesn't touch device_config (e.g. unit fixtures for other
 * sub-mappers).
 */
function mapRingConfigIfPossible(
  fw: FirmwareExport,
  ctx: MapperContext,
  opts: MapFirmwareOptions,
): { inserts: MappedBatch['device_config'], closes: RingConfigClose[] } {
  const windows = fw.ring?.automaticMonitoringData ?? []
  if (windows.length === 0 && !opts.translator) {
    return { inserts: [], closes: [] }
  }
  if (!opts.translator) {
    throw new Error(
      'mapFirmwareExport: firmware ring.automaticMonitoringData has entries but no `translator` was provided in options',
    )
  }
  return mapRingConfig(
    fw.ring ?? { automaticMonitoringData: [] },
    ctx,
    {
      now: opts.now,
      activePriorConfigs: opts.activePriorConfigs,
      translator: opts.translator,
    },
  )
}
