/**
 * @mongrov/device — behavioral types
 *
 * Adapter contract + capability interfaces. Data shapes (Device, DeviceReading,
 * ConnectionState, ErrorDetail, ScanCandidate, DeviceCapability, ...) live in
 * @mongrov/types; this module re-exports them so consumers have one import.
 */

import type {
  ConnectionState,
  DeviceCapability,
  DeviceReading,
  ErrorDetail,
  ScanCandidate,
} from '@mongrov/types'

// Re-export the data shapes for one-stop consumption.
export type {
  ConnectionState,
  Device,
  DeviceCapability,
  DeviceDiagnosticEvent,
  DeviceErrorCategory,
  DeviceReading,
  DeviceStatus,
  ErrorDetail,
  JsonValue,
  ReadingKind,
  ScanCandidate,
  SyncStatus,
} from '@mongrov/types'

// ─────────────────────────────────────────────────────────────────────────
// Adapter ownership + subscription helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Ownership flags declare which lifecycle concerns the adapter (vendor SDK)
 * owns vs which the device machines must drive.
 *
 * - `scan: true`  — adapter runs its own scanner (e.g. JCRing). Registry
 *                   asks the adapter to scan; it does NOT drive ble-plx.
 * - `reconnect`   — `true` = adapter self-reconnects; connection actor is a
 *                   THIN REFLECTOR (mirrors onConnectionChange, no timers).
 *                   `false` = actor is FULL DRIVER (exponential backoff).
 * - `sync: true`  — adapter owns its own sync schedule; coordinator reflects.
 */
export interface AdapterOwnership {
  scan: boolean
  reconnect: boolean
  sync: boolean
}

/** Return type of any adapter-registered listener. */
export type Unsubscribe = () => void

/** Connection-state callback signature used by `DeviceAdapter.onConnectionChange`. */
export type ConnectionChangeListener = (
  deviceId: string,
  state: ConnectionState,
  detail?: ErrorDetail,
) => void

// ─────────────────────────────────────────────────────────────────────────
// DeviceAdapter — the vendor abstraction
// ─────────────────────────────────────────────────────────────────────────

/**
 * One transport-agnostic interface, two satisfaction paths:
 *   - GATT vendors: use `createGattAdapter(profile)` from @mongrov/device/gatt.
 *   - SDK vendors:  hand-write, delegating to the RN wrapper (e.g. JCRing).
 *
 * Adapters map native error detail into `ErrorDetail` — never collapse
 * to a generic "disconnected". This drives ux screen selection and remote
 * diagnostics grouping.
 */
export interface DeviceAdapter {
  /** Stable adapter identity, e.g. `'jcring'` or `'gatt-generic'`. */
  id: string

  /** Predicate: does this adapter handle the given scan hit? First match wins. */
  canHandle(candidate: ScanCandidate): boolean

  /** Which lifecycle concerns this adapter owns vs the machines drive. */
  ownership: AdapterOwnership

  /** Opt-in, composable capabilities exposed via satellite interfaces. */
  capabilities: Set<DeviceCapability>

  /** Idempotent connect. */
  connect(deviceId: string): Promise<void>

  /** Explicit user disconnect. */
  disconnect(deviceId: string): Promise<void>

  /**
   * Subscribe to normalized connection-state updates. Adapters MUST map vendor
   * sub-states DOWN to `ConnectionState` and pass native error detail through
   * `ErrorDetail`.
   */
  onConnectionChange(listener: ConnectionChangeListener): Unsubscribe

  /** Optional scanner — required when `ownership.scan === true`. */
  startScan?(onFound: (candidate: ScanCandidate) => void): Promise<void>
  stopScan?(): Promise<void>
}

// ─────────────────────────────────────────────────────────────────────────
// Capability interfaces (satellites — checked in `capabilities` set)
// ─────────────────────────────────────────────────────────────────────────

/** Continuous stream while connected. */
export interface LiveStreamCapability {
  subscribe(
    deviceId: string,
    onReading: (reading: DeviceReading) => void,
  ): Unsubscribe
}

/**
 * Drains on-device buffer to completion. Cursor is a db-held STOP-HINT — the
 * adapter reads `sinceCursor`, pulls to terminator, emits every reading via
 * `onReading`, and returns the new max cursor. db dedups overlapping runs on
 * `(deviceId, metric, ts)`.
 */
export interface BatchSyncCapability {
  pull(
    deviceId: string,
    metric: string,
    sinceCursor: number | undefined,
    onReading: (reading: DeviceReading) => void,
  ): Promise<{ newCursor: number }>
}

/**
 * Command-initiated, terminating, progress-reporting session (e.g. PPG).
 * Emitted readings carry `tags.source = 'measure'` and do NOT advance the
 * BatchSync cursor.
 */
export interface MeasureCapability {
  startMeasurement(
    deviceId: string,
    type: string,
    onProgress?: (pct: number) => void,
  ): Promise<DeviceReading[]>
}

/** DFU. App orchestration decides WHEN; adapter owns HOW. */
export interface FirmwareCapability {
  getFirmwareInfo(
    deviceId: string,
  ): Promise<{ version: string; updateAvailable: boolean }>
  applyUpdate(
    deviceId: string,
    onProgress: (pct: number) => void,
  ): Promise<void>
}
