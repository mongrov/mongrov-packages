/**
 * Ring config mapper (T-08, Sprint 5 T-09/T-10).
 *
 * Firmware `ring.automaticMonitoringData[]` describes which metrics the ring
 * currently samples and on what schedule. We store these as SCD-2-style rows
 * in `device_config`, with `valid_from = now()` and `valid_to = null` on the
 * new insert.
 *
 * ## The firmware boundary (principles 20 + 21)
 *
 * The vendor struct is `AutomaticMonitoring_J2301A` (JStyle J2301A SDK):
 *
 * ```c
 * int mode;
 * int startTime_Hour;  int startTime_Minutes;
 * int endTime_Hour;    int endTime_Minutes;
 * MyWeeks_J2301A weeks;      // 7 booleans
 * int intervalTime;
 * int dataType;  // 1 = heartRate, 2 = spo2, 3 = temperature, 4 = HRV
 * ```
 *
 * Everything firmware-shaped is translated here and nothing crosses into
 * the warehouse: `dataType` becomes our metric id, split hour/minute fields
 * become `HH:MM` strings, and the seven-boolean `weeks` struct becomes a
 * bitmask. Principle 21 is explicit that firmware enums must not reach the
 * schema, so `device_config` stores `metric`, never `data_type`.
 *
 * Prior versions inverted this: the mapper's input type had already
 * discarded `dataType`, so a consumer-supplied `RingConfigTranslator` had
 * to invent the enum back from our own metric names — the schema ended up
 * holding a firmware integer that the app, not the firmware, produced.
 *
 * Closing prior config (SCD-2 semantics):
 *   The mapper accepts an optional `activePriorConfigs` map keyed by
 *   metric. For every metric present in the new snapshot, if a prior config
 *   was open, it emits a `close` entry so the sink can `UPDATE ... SET
 *   valid_to = now()` before the INSERT lands. Metrics present in the prior
 *   map but absent from the new snapshot are left open — the ring is silent
 *   on them, not disabling them.
 */

import type {
  DeviceConfigRow,
  FirmwareMonitoringWindow,
  FirmwareRingConfig,
  FirmwareWeekdays,
  MapperContext,
} from './types'

/**
 * Firmware `dataType` → our metric id (Sprint 5 T-09).
 *
 * Verbatim from the vendor header's own comment. Note this is a **1:1**
 * map: `dataType = 2` is SpO₂ alone, and temperature is its own code 3.
 * The Sprint 5 spec described 2 as "spo2 + temperature (shared schedule)"
 * requiring a fan-out to two rows; the SDK does not agree, so there is
 * nothing to fan out.
 *
 * (Whether firmware *slaves* the two schedules together in practice is a
 * separate, still-open question — but it would not change this mapping,
 * only mean the ring reports two windows with identical timings.)
 */
export const FIRMWARE_DATA_TYPE_TO_METRIC: Readonly<Record<number, string>> = Object.freeze({
  1: 'heart_rate',
  2: 'spo2',
  3: 'temperature',
  4: 'hrv',
})

/** Reverse map, for diagnostics and for keying prior-config reads. */
export const METRIC_TO_FIRMWARE_DATA_TYPE: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    Object.entries(FIRMWARE_DATA_TYPE_TO_METRIC).map(([dt, m]) => [m, Number(dt)]),
  ),
)

/**
 * Translate a firmware `dataType` to the metric(s) it schedules.
 *
 * Returns an array for forward-compatibility — if a future firmware
 * revision genuinely does share one code across metrics, this signature
 * absorbs it without a breaking change.
 *
 * @throws on an unknown code, with the raw value in the message. Silently
 *   dropping an unrecognised code would mean a metric the ring is actively
 *   sampling never appears in `device_config`, and every cadence-dependent
 *   consumer would fall back to the `metric_metadata` default without
 *   anyone noticing.
 */
export function firmwareDataTypeToMetrics(dataType: number): string[] {
  const metric = FIRMWARE_DATA_TYPE_TO_METRIC[dataType]
  if (metric === undefined) {
    const known = Object.entries(FIRMWARE_DATA_TYPE_TO_METRIC)
      .map(([dt, m]) => `${dt}=${m}`)
      .join(', ')
    throw new Error(
      `mapRingConfig: unknown firmware dataType ${dataType}. `
      + `Known values: ${known}. A new value means the ring firmware added a `
      + `monitored metric — add it to FIRMWARE_DATA_TYPE_TO_METRIC and to `
      + `METRIC_METADATA rather than dropping it.`,
    )
  }
  return [metric]
}

/** Vendor weekday order, LSB = Sunday. */
const WEEKDAY_ORDER: readonly (keyof FirmwareWeekdays)[] = [
  'sunday',
  'monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

/**
 * Seven booleans → a 7-bit mask for `device_config.weeks`.
 * Bit 0 = Sunday … bit 6 = Saturday. All-days is `0x7F`.
 */
export function weekdaysToBitmask(weeks: FirmwareWeekdays | undefined): number | null {
  if (!weeks)
    return null
  let mask = 0
  WEEKDAY_ORDER.forEach((day, i) => {
    if (weeks[day])
      mask |= 1 << i
  })
  return mask
}

/** `HH:MM`, zero-padded. Null when the firmware supplied out-of-range values. */
export function formatClockTime(hour: number, minutes: number): string | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23)
    return null
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59)
    return null
  return `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export interface RingConfigClose {
  device_id: string
  /** Our metric id — matches `device_config.metric`. */
  metric: string
  valid_to: Date
}

export interface MapRingConfigResult {
  inserts: DeviceConfigRow[]
  closes: RingConfigClose[]
}

export interface MapRingConfigOptions {
  now?: Date
  /** Prior open configs for this device, keyed by metric id. */
  activePriorConfigs?: ReadonlyMap<string, DeviceConfigRow>
}

export function mapRingConfig(
  fw: FirmwareRingConfig,
  ctx: MapperContext,
  opts: MapRingConfigOptions = {},
): MapRingConfigResult {
  const now = opts.now ?? new Date()
  const prior = opts.activePriorConfigs ?? new Map<string, DeviceConfigRow>()

  const inserts: DeviceConfigRow[] = []
  const closes: RingConfigClose[] = []

  for (const window of fw.automaticMonitoringData ?? []) {
    for (const metric of firmwareDataTypeToMetrics(window.dataType)) {
      inserts.push(toRow(window, ctx, now, metric))
      if (prior.has(metric)) {
        closes.push({ device_id: ctx.deviceId, metric, valid_to: now })
      }
    }
  }

  return { inserts, closes }
}

function toRow(
  window: FirmwareMonitoringWindow,
  ctx: MapperContext,
  now: Date,
  metric: string,
): DeviceConfigRow {
  return {
    brand: ctx.brand,
    family_id: ctx.familyId,
    user_id: ctx.userId,
    device_id: ctx.deviceId,
    metric,
    interval_minutes: window.intervalTime,
    start_time: formatClockTime(window.startTime_Hour, window.startTime_Minutes),
    end_time: formatClockTime(window.endTime_Hour, window.endTime_Minutes),
    weeks: weekdaysToBitmask(window.weeks),
    valid_from: now,
    valid_to: null,
  }
}
