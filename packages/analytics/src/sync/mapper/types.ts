/**
 * Firmware and mapped-row types shared across every mapper module.
 *
 * Firmware shapes (`Firmware*Row`, `FirmwareExport`, `FirmwareRingConfig`) are
 * *input* — they mirror the JSON the ring firmware emits at sync time.
 *
 * Row shapes (`HrvRow`, `HeartRateRow`, ...) are *output* — they match the
 * warehouse DDL in `core/schemas.ts`. Every mapper is a pure function from
 * `Firmware*Row[]` (+ `MapperContext`) to `<Row>[]`.
 *
 * See `.specifica/features/analytics-sync/spec.md` §Firmware mapper and
 * `.specifica/features/analytics-core/spec.md` §Table schema.
 */

// -------------------- context --------------------

export interface MapperContext {
  brand: string
  familyId: string
  userId: string
  deviceId: string
  /** IANA timezone string, e.g. 'America/Los_Angeles'. */
  userTimezone: string
  /**
   * Random-id source for session ids (principle 25). Defaults to
   * `() => nanoid(24)`. Injectable so tests can keep the mapper
   * deterministic — the hash suffix of a session id is always
   * deterministic regardless of this generator.
   */
  idGenerator?: () => string
}

// -------------------- firmware input --------------------

export interface FirmwareHRVRow {
  timestamp: string // "YYYY.MM.DD HH:MM:SS" UTC
  hrv?: number
  stress?: number
  /** Sentinel 0 → NULL. Preserved as collected_only. */
  heartRate?: number
  systolicBP?: number
  diastolicBP?: number
  vascularAging?: number
}

export interface FirmwareHRRow {
  timestamp: string
  singleHR: number
}

export interface FirmwareSpO2Row {
  timestamp: string
  automaticSpo2Data: number
}

export interface FirmwareTempRow {
  timestamp: string
  temperature: number
}

export interface FirmwareActivityRow {
  timestamp: string
  step: number
  calories: number
  distance: number
  arraySteps: number[] // length 10, 1-min buckets
}

export interface FirmwareSleepRow {
  start: string // session start
  end: string
  block_type: string // 'primary' | 'light' | 'deep' | 'rem' | 'awake'
  confidence: number
  timestamp: string // block instant
  /**
   * Raw per-block quality score, when the firmware revision carries one.
   * Passed through verbatim to `sleep_raw.quality`. Revisions that omit it
   * fall back to `round(confidence * 100)` — see `mapper/sleep.ts`.
   */
  quality?: number
  /**
   * Block width in minutes, when the firmware revision carries one.
   * Passed through verbatim to `sleep_raw.unit_length`; drives stage-minute
   * accumulation. Defaults to `DEFAULT_BLOCK_MINUTES` (1) when absent.
   */
  unit_length?: number
}

export interface FirmwareBatteryRow {
  timestamp: string
  battery: number // 0..100
}

export interface FirmwareRingConfig {
  automaticMonitoringData: FirmwareMonitoringWindow[]
}

/**
 * One automatic-monitoring window, verbatim from the JStyle J2301A SDK's
 * `AutomaticMonitoring_J2301A` struct (see `BleSDK_Header_J2301A.h`, and
 * `AutomaticMonitoringData` in `@mongrov/zivacore`).
 *
 * Firmware-native naming and shape on purpose (principle 20): `dataType`
 * stays an integer, hours and minutes stay split, `weeks` stays a struct of
 * seven booleans. Every one of those is translated at the mapper boundary
 * and none reaches a warehouse column.
 *
 * An earlier version of this type read `{metric: string, interval_minutes,
 * start_hour, end_hour}`, which matched no vendor type — it had already
 * discarded `dataType`, which is why consumers had to supply a
 * `RingConfigTranslator` inventing the enum back from our own metric names.
 */
export interface FirmwareMonitoringWindow {
  /** 1 = heartRate, 2 = spo2, 3 = temperature, 4 = HRV. */
  dataType: number
  /** Sampling cadence in minutes. */
  intervalTime: number
  startTime_Hour: number
  startTime_Minutes: number
  endTime_Hour: number
  endTime_Minutes: number
  weeks: FirmwareWeekdays
  /**
   * Vendor field with undocumented semantics — carried through so the
   * shape stays faithful, but not currently mapped to any column.
   */
  mode?: number
}

/** Per-weekday enable flags. Vendor casing (`Tuesday`..`Saturday`) preserved. */
export interface FirmwareWeekdays {
  sunday: boolean
  monday: boolean
  Tuesday: boolean
  Wednesday: boolean
  Thursday: boolean
  Friday: boolean
  Saturday: boolean
}

export interface FirmwareExport {
  heartrate: FirmwareHRRow[]
  hrv_table: FirmwareHRVRow[]
  spo2: FirmwareSpO2Row[]
  temperature_table: FirmwareTempRow[]
  activitydetails: FirmwareActivityRow[]
  sleep_processed: FirmwareSleepRow[]
  battery_table: FirmwareBatteryRow[]
  ring: FirmwareRingConfig
}

// -------------------- mapped output --------------------

/**
 * Tenant columns every warehouse row carries (spec §Table schema —
 * "every sensor row carries brand, family_id, user_id"). Split out from
 * `BaseRow` because `sleep_session` has no `ts` column: its time axis is
 * `ts_start` / `ts_end`.
 */
interface TenantRow {
  brand: string
  family_id: string
  user_id: string
  device_id: string
}

interface BaseRow extends TenantRow {
  ts: Date
}

export interface HrvRow extends BaseRow {
  hrv_ms: number | null
  stress: number | null
  systolic_bp: number | null
  diastolic_bp: number | null
  vascular_aging: number | null
}

export interface HeartRateRow extends BaseRow {
  bpm: number
}

export interface Spo2Row extends BaseRow {
  spo2: number
}

export interface TemperatureRow extends BaseRow {
  temp_c: number
}

export interface ActivityRow extends BaseRow {
  steps: number
}

/**
 * `activity_bucket` warehouse row — 10-min calories/distance. Steps are NOT
 * carried here: they live in `activity` at 1-min resolution after unnest
 * (spec §Table schema). A `steps` field here would silently double-count.
 */
export interface ActivityBucketRow extends BaseRow {
  calories: number
  distance_km: number
}

/**
 * `sleep_session` warehouse row. Column names + nullability mirror the DDL
 * in `core/schemas.ts` exactly, so `row[c]` keyed by
 * `columnOrder.sleep_session` yields correct positional appender input.
 *
 * No `ts` — the DDL partitions on `day(ts_start)`.
 */
export interface SleepSessionRow extends TenantRow {
  session_id: string
  ts_start: Date
  ts_end: Date
  total_minutes: number
  deep_minutes: number | null
  rem_minutes: number | null
  light_minutes: number | null
  awake_minutes: number | null
  avg_confidence: number | null
  night_of: Date
}

/**
 * `sleep_stage` warehouse row. `stage` is the DDL's integer code
 * (`SLEEP_STAGE_CODES`), never the raw firmware `block_type` string —
 * principle 20: firmware enums do not reach our schema.
 */
export interface SleepStageRow extends BaseRow {
  session_id: string
  stage: number
  confidence: number | null
}

/**
 * `sleep_raw` warehouse row (`collected_only`). Preserves each firmware
 * block for reprocessing, flattened onto the DDL's columns rather than
 * stashed as an opaque payload blob.
 */
export interface SleepRawRow extends BaseRow {
  ts_session_start: Date
  quality: number
  unit_length: number | null
}

export interface DeviceEventRow extends BaseRow {
  event_type: string
  payload: Record<string, unknown>
}

/**
 * `device_battery` warehouse row — numeric battery samples in a dedicated
 * table (0.6.0, fix B2). Battery previously rode `device_event.payload`
 * as JSON, which the rules compiler could not aggregate numerically.
 */
export interface DeviceBatteryRow extends BaseRow {
  battery_pct: number
}

/**
 * `device_config` warehouse row shape (SCD-2). Column names match the DDL in
 * `core/schemas.ts` exactly so that a `row[c]` lookup keyed by
 * `columnOrder.device_config` produces the correct positional appender input.
 *
 * Fields that the firmware doesn't natively speak in schema terms
 * (`data_type`, `start_time`, `end_time`, `weeks`) are produced by a
 * consumer-provided `RingConfigTranslator` (see below).
 */
export interface DeviceConfigRow extends TenantRow {
  /**
   * OUR metric id (`spo2`, `hrv`, …), never the firmware enum
   * (principle 21). Derived from `dataType` by `firmwareDataTypeToMetrics`.
   */
  metric: string
  interval_minutes: number
  start_time: string | null
  end_time: string | null
  weeks: number | null
  valid_from: Date
  valid_to: Date | null
}

/**
 * @deprecated Since the mapper consumes the real vendor shape, translation
 * is no longer consumer-specific and happens inside
 * `mapper/ring-config.ts`. Kept as an exported type for one release so
 * existing `createSyncManager({ ringConfigTranslator })` call sites keep
 * compiling; the value is ignored.
 */
export interface RingConfigTranslator {
  metricToDataType?: (metric: string) => number
  dataTypeToMetric?: (dataType: number) => string
  windowToSchemaFields?: (window: FirmwareMonitoringWindow) => {
    start_time: string | null
    end_time: string | null
    weeks: number | null
  }
}

export interface MappedBatch {
  hrv: HrvRow[]
  heart_rate: HeartRateRow[]
  spo2: Spo2Row[]
  temperature: TemperatureRow[]
  activity: ActivityRow[]
  activity_bucket: ActivityBucketRow[]
  sleep_session: SleepSessionRow[]
  sleep_stage: SleepStageRow[]
  sleep_raw: SleepRawRow[]
  device_event: DeviceEventRow[]
  device_battery: DeviceBatteryRow[]
  device_config: DeviceConfigRow[]
}
