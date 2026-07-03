// @mongrov/types — device additions (v0.3.0 → v0.4.0)
//
// DATA SHAPES ONLY. Behavioral ports (ReadingSink, ConfigStore, DeviceLogger, LifecyclePort)
// live in @mongrov/device (see ports.ts) — device declares the interfaces it consumes.
//
// IP boundary: shapes are the empty container. `value` is OPAQUE (JsonValue); `metric`/`kind`/`unit`
// describe structure, never product meaning. The metric vocabulary and per-metric value schemas live
// in the app (ziva-metrics.ts, luminx-metrics.ts), never here and never as README examples.
// All additions are additive and backwards compatible.

// ─────────────────────────────────────────────────────────────────────────
// Opaque payload type
// ─────────────────────────────────────────────────────────────────────────

/** Any JSON-serializable value. The package never inspects a reading's payload shape. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

// ─────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────

/**
 * A pre-connection scan hit. Carries enough for `DeviceAdapter.canHandle()` to route it.
 * Produced by the shared ble-plx scanner (raw) or by an adapter's own scanner (already attributed).
 */
export interface ScanCandidate {
  id: string
  name?: string
  rssi?: number
  /** Raw manufacturer-specific data (hex), for vendor identification in canHandle(). */
  manufacturerData?: string
  /** Advertised service UUIDs, for GATT-profile matching. */
  serviceUUIDs?: string[]
  /** Set when an adapter's own scanner produced this hit. */
  adapterId?: string
}

// ─────────────────────────────────────────────────────────────────────────
// Connection
// ─────────────────────────────────────────────────────────────────────────

/**
 * Normalized connection state. Vendor sub-states (DISCOVERING_SERVICES, ENABLING_NOTIFICATIONS,
 * vendor RECONNECTING, …) are mapped DOWN to these by the adapter. NOTE: an empty scan is NOT
 * 'failed' — it resolves to 'idle' with zero results; ux renders "none found" from context.
 */
export type ConnectionState =
  | 'idle'
  | 'scanning'
  | 'connecting'
  | 'discovering'
  | 'ready'
  | 'reconnecting'
  | 'disconnecting'
  | 'suspended' // global interrupt active (bluetooth-off / permission / background)
  | 'failed'

/** Error category — drives ux screen selection + retry routing. */
export type DeviceErrorCategory =
  | 'timeout'
  | 'out-of-range'
  | 'rejected'
  | 'slot-full'
  | 'bluetooth-off'
  | 'permission-denied'
  | 'backgrounded'
  | 'unexpected-disconnect'
  | 'unknown'

/**
 * Native-detail carrier. Adapters MUST map native error detail here (GATT 147, write-queue timeout,
 * Nordic disconnect reason) — never collapse to a generic "disconnected".
 */
export interface ErrorDetail {
  category: DeviceErrorCategory
  phase: string
  canRetry: boolean
  recoveryActions?: string[]
  nativeCode?: string | number
  nativeMessage?: string
}

// ─────────────────────────────────────────────────────────────────────────
// Device + status
// ─────────────────────────────────────────────────────────────────────────

/** A device the registry knows about (discovered or connected). */
export interface Device {
  /** Stable identity within the app (redact before remote log). */
  id: string
  /** Which adapter handles this device (e.g. 'jcring', 'gatt-generic'). */
  adapterId: string
  name?: string
  /** Open string set the adapter supports, e.g. 'ring' | 'band' | 'tracker'. */
  kind?: string
  state: ConnectionState
  rssi?: number
  /** True if this device belongs to the current account/user (vs guest/nearby). */
  owned?: boolean
}

/** Snapshot of device health/identity. firmwareVersion from vendor GetDeviceVersion(). */
export interface DeviceStatus {
  deviceId: string
  batteryPct?: number
  firmwareVersion?: string
  capabilities: DeviceCapability[]
  lastSeenAt?: number
}

/** Opt-in, composable adapter capabilities. Mirrors collab MessagingAdapter capabilities. */
export type DeviceCapability = 'LiveStream' | 'BatchSync' | 'Measure' | 'Firmware'

// ─────────────────────────────────────────────────────────────────────────
// Readings — producer↔consumer contract (device emits, db consumes)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Generic STRUCTURE class of a reading's payload — NOT its meaning. db routes storage on this,
 * ux picks a renderer on this; neither inspects `value`. The package can read `kind`; it can never
 * read what `metric` means.
 *   scalar — one number          (hr, spo2, temperature, battery)
 *   vector — numeric array        (imu / accelerometer sample)
 *   geo    — { lat, lng, … }      (tracker location)
 *   sample — waveform / series    (ppg trace)
 *   blob   — opaque structured     (sleep stages, activity summary)
 */
export type ReadingKind = 'scalar' | 'vector' | 'geo' | 'sample' | 'blob'

/**
 * A single reading. Identity is (deviceId, metric, ts) — db dedups overlapping backlog vs live on
 * this key (idempotent upsert), WITHIN a device. No cross-device fusion: separate devices are
 * separate streams. `value` is opaque; `kind`/`unit` are generic shape hints; `metric` is an open
 * vendor string whose payload SCHEMA lives in the app, not here.
 *
 * `tags.source` distinguishes passive sync from a user-initiated Measure; Measure readings do NOT
 * advance the BatchSync cursor.
 */
export interface DeviceReading {
  deviceId: string
  /** Open vocabulary: 'hr' | 'spo2' | 'hrv' | 'temperature' | 'sleep' | 'activity' | 'location' | … */
  metric: string
  /** Generic structure class — db/ux route on this, never on `metric`. */
  kind: ReadingKind
  /** Device-clock timestamp (ms). Part of the dedup key. */
  ts: number
  /** OPAQUE payload — the package never inspects it. App owns the per-metric schema. */
  value: JsonValue
  /** Generic unit, optional: 'bpm' | 'celsius' | '%' | 'm' | … */
  unit?: string
  /** Optional vendor sequence number — alternative identity when ts collides. */
  seq?: number
  /** Phone-clock receive time. Enables v2 clock-skew correction with no schema change. */
  receivedAt: number
  /** Free tags bag — sample window, etc., plus `source` provenance. */
  tags?: { source?: 'live' | 'backlog' | 'measure' } & Record<string, JsonValue>
}

// ─────────────────────────────────────────────────────────────────────────
// Sync
// ─────────────────────────────────────────────────────────────────────────

export type SyncStatus = 'idle' | 'pulling' | 'draining' | 'failed' | 'cancelled'

// ─────────────────────────────────────────────────────────────────────────
// Diagnostics — typed, not free-text. Emitted by machines on failure/recovery/interrupt.
// Redaction + opt-in gate applied by the APP's logger mapping before REMOTE upload only.
// ─────────────────────────────────────────────────────────────────────────

export interface DeviceDiagnosticEvent {
  /** Redact (hash) before remote upload — app responsibility. */
  deviceId: string
  adapterId: string
  trigger: 'failed' | 'reconnecting' | 'suspended' | 'resumed' | 'sync-failed'
  phase: string
  category: DeviceErrorCategory
  rssi?: number
  attempt?: number
  durationMs?: number
  nativeCode?: string | number
  nativeMessage?: string
  ts: number
}
