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
 *
 * An unchanged schedule is a READ, not a new version (principle 66):
 *   the handshake reads the schedule on every sync, and every read used to
 *   close the open row and insert an identical one, so `device_config` grew
 *   by one row per metric per sync, forever (it is never swept), and pushing
 *   the same export twice went 3 -> 6 rows. When the metric's single open row
 *   already holds exactly the schedule just read, the mapper now emits a
 *   `read` instead: the sink moves that row's `valid_from` to the read time,
 *   and nothing is closed or inserted.
 *
 *   Why move `valid_from` rather than do nothing: Auto Monitoring retires a
 *   pending change once a read of the ring LATER than the write has landed,
 *   whatever it says (`overrideRetired`, zivaone_app#508/#662), and it learns
 *   the read time from the answering row's `valid_from`. Doing nothing would
 *   leave a write the ring dropped "pending" forever. The history the screens
 *   read is unaffected: the previous version's `valid_to` still marks when
 *   this schedule began, and `device.metricCadence` answers a day between the
 *   two with the nearest later row, which is this one. V1 kept only the
 *   latest read (`RingContextProvider` state), which is what the open row is.
 *
 *   Anything else (no open row, more than one open row — older installs, or
 *   two exports buffered before one flush — more than one window for the
 *   metric, or a different schedule) takes the close + insert path, which
 *   converges to one open row.
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

/**
 * The ring re-reported the schedule its open row already holds: no new
 * version, only the read time moves (see the module doc).
 */
export interface RingConfigRead {
  device_id: string
  /** Our metric id — matches `device_config.metric`. */
  metric: string
  /** The open row's `valid_from` as read; the UPDATE matches it exactly. */
  prior_valid_from: Date
  /** When this read was taken; becomes the row's `valid_from`. */
  read_at: Date
}

export interface MapRingConfigResult {
  inserts: DeviceConfigRow[]
  closes: RingConfigClose[]
  reads: RingConfigRead[]
}

export interface MapRingConfigOptions {
  now?: Date
  /**
   * Prior open configs for this device, keyed by metric id. An array when a
   * metric has more than one open row (`fetchActivePriorConfigs` keeps them
   * all, so a duplicate is converged rather than hidden).
   */
  activePriorConfigs?: ReadonlyMap<string, DeviceConfigRow | readonly DeviceConfigRow[]>
}

/** The columns that make a schedule: what a re-read must match to be "unchanged". */
function sameSchedule(a: DeviceConfigRow, b: DeviceConfigRow): boolean {
  return Number(a.interval_minutes) === Number(b.interval_minutes)
    && (a.start_time ?? null) === (b.start_time ?? null)
    && (a.end_time ?? null) === (b.end_time ?? null)
    && (a.weeks == null ? null : Number(a.weeks)) === (b.weeks == null ? null : Number(b.weeks))
}

export function mapRingConfig(
  fw: FirmwareRingConfig,
  ctx: MapperContext,
  opts: MapRingConfigOptions = {},
): MapRingConfigResult {
  const now = opts.now ?? new Date()
  const prior = opts.activePriorConfigs ?? new Map<string, DeviceConfigRow>()
  const openRows = (metric: string): readonly DeviceConfigRow[] => {
    const p = prior.get(metric)
    if (p === undefined)
      return []
    return Array.isArray(p) ? p : [p as DeviceConfigRow]
  }

  // Grouped by metric first: whether a read is "unchanged" is a property of
  // the metric's whole schedule, not of one window.
  const byMetric = new Map<string, DeviceConfigRow[]>()
  for (const window of fw.automaticMonitoringData ?? []) {
    for (const metric of firmwareDataTypeToMetrics(window.dataType)) {
      const rows = byMetric.get(metric) ?? []
      rows.push(toRow(window, ctx, now, metric))
      byMetric.set(metric, rows)
    }
  }

  const inserts: DeviceConfigRow[] = []
  const closes: RingConfigClose[] = []
  const reads: RingConfigRead[] = []

  for (const [metric, rows] of byMetric) {
    const open = openRows(metric)
    const only = open.length === 1 ? open[0] : undefined
    if (only !== undefined && rows.length === 1 && sameSchedule(only, rows[0]!)) {
      // Never move valid_from backwards: an export mapped with an older
      // `now` than the row holds is not a newer read.
      if (now.getTime() > only.valid_from.getTime())
        reads.push({ device_id: ctx.deviceId, metric, prior_valid_from: only.valid_from, read_at: now })
      continue
    }
    inserts.push(...rows)
    if (open.length > 0)
      closes.push({ device_id: ctx.deviceId, metric, valid_to: now })
  }

  return { inserts, closes, reads }
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
