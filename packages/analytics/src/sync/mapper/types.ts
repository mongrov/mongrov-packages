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
  block_type: string // 'primary' | 'light' | 'deep' | 'rem' | ...
  confidence: number
  timestamp: string // block instant
}

export interface FirmwareBatteryRow {
  timestamp: string
  battery: number // 0..100
}

export interface FirmwareRingConfig {
  automaticMonitoringData: FirmwareMonitoringWindow[]
}

export interface FirmwareMonitoringWindow {
  metric: string // 'hrv' | 'spo2' | ...
  interval_minutes: number
  start_hour: number
  end_hour: number
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

interface BaseRow {
  ts: Date
  brand: string
  family_id: string
  user_id: string
  device_id: string
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

export interface ActivityBucketRow extends BaseRow {
  steps: number
  calories: number
  distance_km: number
}

export interface SleepSessionRow extends BaseRow {
  session_id: string
  start_ts: Date
  end_ts: Date
  night_of: Date
}

export interface SleepStageRow extends BaseRow {
  session_id: string
  stage: string
  confidence: number
}

export interface SleepRawRow extends BaseRow {
  payload: FirmwareSleepRow
}

export interface DeviceEventRow extends BaseRow {
  event_type: string
  payload: Record<string, unknown>
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
export interface DeviceConfigRow extends BaseRow {
  data_type: number
  interval_minutes: number
  start_time: string | null
  end_time: string | null
  weeks: number | null
  valid_from: Date
  valid_to: Date | null
}

/**
 * Consumer-provided translation from firmware ring-config semantics to
 * warehouse schema semantics. Required at `createSyncManager()` time whenever
 * the subscribed tables include `'device_config'`.
 *
 * Split into three responsibilities so the mapper can:
 *   - materialize `data_type` per insert (`metricToDataType`);
 *   - key `activePriorConfigs` by `data_type` when reading local state
 *     (`dataTypeToMetric` — round-trips the enum for callers that want to
 *     surface metric names in logs or diagnostics);
 *   - compute the schema-shaped time fields per firmware window
 *     (`windowToSchemaFields`).
 */
export interface RingConfigTranslator {
  metricToDataType: (metric: string) => number
  dataTypeToMetric: (dataType: number) => string
  windowToSchemaFields: (window: FirmwareMonitoringWindow) => {
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
  device_config: DeviceConfigRow[]
}
