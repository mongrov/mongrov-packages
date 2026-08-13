/**
 * Cross-package contracts for the Sprint 4 data plane (spec.md §18 —
 * "Cross-package interface stubs").
 *
 * These four interfaces are the seams between packages that must not import
 * each other at runtime:
 *
 *   @mongrov/device  --FirmwareExport-->  @mongrov/analytics/sync
 *   @mongrov/device  --SensorSink------>  @mongrov/analytics/sync
 *   @mongrov/data-access --EventBus---->  @mongrov/analytics
 *
 * Contracts only; every implementation lives elsewhere. `EventBus`'s
 * implementation is owned by `@mongrov/data-access` (principle 50) — the
 * contract flows data-access → analytics and never back, so there is no
 * runtime cycle.
 *
 * Zero runtime — interfaces only.
 */

/** Fire-and-forget unsubscribe handle. */
export type Unsubscribe = () => void

// ─────────────────────────────────────────────────────────────────────────
// Firmware export — the mapper's input contract
// ─────────────────────────────────────────────────────────────────────────

/**
 * Canonical shape of a ZivaOne ring export.
 *
 * This is **upstream input, not our schema** (principle 20). Field names,
 * casing, and quirks here mirror what the firmware emits; every one of them
 * is translated at the `analytics/sync` mapper boundary and none reaches a
 * warehouse column. Changes to this shape require a coordinated types bump
 * plus a mapper revision — see principle 60 on fixture governance.
 */
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

/** Firmware timestamps are `"YYYY.MM.DD HH:MM:SS"` in UTC wall-clock. */
export type FirmwareTimestamp = string

export interface FirmwareHRRow {
  timestamp: FirmwareTimestamp
  singleHR: number
}

export interface FirmwareHRVRow {
  timestamp: FirmwareTimestamp
  hrv?: number
  stress?: number
  /** Sentinel `0` means "no reading" and maps to NULL, not zero. */
  heartRate?: number
  systolicBP?: number
  diastolicBP?: number
  vascularAging?: number
}

export interface FirmwareSpO2Row {
  timestamp: FirmwareTimestamp
  automaticSpo2Data: number
}

export interface FirmwareTempRow {
  timestamp: FirmwareTimestamp
  /** Whole degrees Celsius per firmware. */
  temperature: number
}

export interface FirmwareActivityRow {
  timestamp: FirmwareTimestamp
  step: number
  calories: number
  distance: number
  /** Ten 1-minute step buckets covering the row's 10-minute window. */
  arraySteps: number[]
}

export interface FirmwareSleepRow {
  start: FirmwareTimestamp
  end: FirmwareTimestamp
  /** `'primary' | 'light' | 'deep' | 'rem' | 'awake'` — open string set. */
  block_type: string
  confidence: number
  timestamp: FirmwareTimestamp
  quality?: number
  unit_length?: number
}

export interface FirmwareBatteryRow {
  timestamp: FirmwareTimestamp
  /** 0..100. */
  battery: number
}

export interface FirmwareRingConfig {
  automaticMonitoringData: FirmwareMonitoringWindow[]
}

export interface FirmwareMonitoringWindow {
  metric: string
  interval_minutes: number
  start_hour: number
  end_hour: number
}

// ─────────────────────────────────────────────────────────────────────────
// Mapper context
// ─────────────────────────────────────────────────────────────────────────

/**
 * Tenancy + locale context the mapper stamps onto every produced row.
 *
 * `userTimezone` is required, not optional: `night_of` attribution and
 * local-day grouping are wrong without it, and a silent UTC default would
 * mis-bucket every sleep session for users west of Greenwich.
 */
export interface MapperContext {
  brand: string
  familyId: string
  userId: string
  deviceId: string
  /** IANA zone, e.g. `'America/Los_Angeles'`. */
  userTimezone: string
}

// ─────────────────────────────────────────────────────────────────────────
// Sensor sink — the device → analytics write seam
// ─────────────────────────────────────────────────────────────────────────

/** One table's worth of already-mapped rows, with routing context. */
export interface SensorBatch {
  table: string
  brand: string
  familyId: string
  userId: string
  deviceId: string
  rows: Record<string, unknown>[]
}

/** Outcome of flushing one table. */
export interface FlushResult {
  table: string
  rowsFlushed: number
  ok: boolean
}

/**
 * Write-side API the device layer calls. Buffering, overflow durability,
 * batching, and retry are the sink's problem, not the caller's — `push` and
 * `pushFirmware` resolve once the rows are durably buffered, not once they
 * reach DuckDB.
 */
export interface SensorSink {
  /** Enqueue pre-mapped rows for one table. */
  push: (batch: SensorBatch) => Promise<void>
  /** Enqueue a raw firmware export; the sink runs the mapper. */
  pushFirmware: (fw: FirmwareExport, ctx: MapperContext) => Promise<void>
  /** Force a flush of every buffered table. */
  flush: () => Promise<FlushResult[]>
  /** Rows buffered but not yet flushed, optionally for one table. */
  pendingRowCount: (table?: string) => Promise<number>
  /** Drop all buffered rows, including MMKV overflow. */
  clear: () => Promise<void>
}

// ─────────────────────────────────────────────────────────────────────────
// Event bus — implementation owned by @mongrov/data-access (principle 50)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Invalidation + domain event bus.
 *
 * Glob semantics are frozen (principle 49): `*` matches exactly one
 * colon-delimited segment, `**` matches one or more, matching is
 * case-sensitive, and no other wildcards exist.
 */
export interface EventBus {
  emit: <T>(name: string, payload: T) => void
  /** Exact-name subscription. */
  subscribe: <T>(name: string, handler: (payload: T) => void) => Unsubscribe
  /** Glob subscription; the handler receives the concrete name that matched. */
  subscribePattern: <T>(
    pattern: string,
    handler: (name: string, payload: T) => void,
  ) => Unsubscribe
}
