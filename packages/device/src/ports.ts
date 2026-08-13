/**
 * @mongrov/device — ports
 *
 * Behavioral contracts the device package CONSUMES. Ports are device-owned:
 * @mongrov/types stays data-only; device declares the interfaces it needs.
 *
 * Apps supply concrete implementations at DeviceProvider wiring:
 *   ReadingSink   → @mongrov/db
 *   ConfigStore   → @mongrov/db
 *   DeviceLogger  → app-defined mapping to @mongrov/core (redaction + opt-in gate)
 *   LifecyclePort → starter lib/lifecycle/ (maps to AppState)
 *
 * The device package itself never imports @mongrov/db, @mongrov/core, MMKV, or ble-plx.
 */

import type {
  DeviceDiagnosticEvent,
  DeviceReading,
} from '@mongrov/types'
import type {
  DeviceEventPayload,
  DeviceEventType,
} from '@mongrov/types/device-events'

// ─────────────────────────────────────────────────────────────────────────
// ReadingSink — device emits readings; db consumes.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Idempotent by contract: db dedups on `(deviceId, metric, ts)`. Adapters
 * MAY re-emit overlapping backlog vs live; db collapses the overlap to one row.
 */
export interface ReadingSink {
  write: (reading: DeviceReading) => Promise<void>
}

// ─────────────────────────────────────────────────────────────────────────
// ConfigStore — cursor persistence for BatchSync.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Per-(deviceId, metric) cursor storage. Cursor is a db-held STOP-HINT,
 * not vendor SDK state. Device stays stateless; the adapter reads the cursor,
 * pulls to terminator, and writes the new cursor back.
 */
export interface ConfigStore {
  getCursor: (deviceId: string, metric: string) => Promise<number | undefined>
  setCursor: (deviceId: string, metric: string, cursor: number) => Promise<void>
}

// ─────────────────────────────────────────────────────────────────────────
// DeviceLogger — typed diagnostics emit.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Machines emit `DeviceDiagnosticEvent` on every failed / reconnecting /
 * suspended / resumed / sync-failed transition. The app maps the event
 * onto @mongrov/core, applies redaction + opt-in gate, and forwards to
 * WebhookTransport for remote diagnostics.
 */
export interface DeviceLogger {
  log: (event: DeviceDiagnosticEvent) => void
}

// ─────────────────────────────────────────────────────────────────────────
// LifecyclePort — foreground/background signal source.
// ─────────────────────────────────────────────────────────────────────────

/** Return type of `LifecyclePort.subscribe`. */
export type LifecycleUnsubscribe = () => void

/** Foreground/background state; drives global BACKGROUNDED / RESUMED interrupts. */
export type LifecycleState = 'foreground' | 'background'

/**
 * Foreground/background notifications. The device package never imports
 * `AppState` directly — apps map their platform lifecycle to this port.
 */
export interface LifecyclePort {
  subscribe: (listener: (state: LifecycleState) => void) => LifecycleUnsubscribe
}

// ─────────────────────────────────────────────────────────────────────────
// DeviceEventSink — typed lifecycle events the analytics plane records.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Durable device lifecycle events (Sprint 5 §6 / T-39).
 *
 * Distinct from `DeviceLogger`, and the distinction matters:
 *
 * - `DeviceLogger` is **diagnostics** — transient, opt-in, redacted, aimed
 *   at a webhook for debugging. Dropping one costs nothing.
 * - `DeviceEventSink` is **data** — rows in `device_event` that screens
 *   read. `device.lastSyncedAt` (the "Updated 2 min ago" label) is a query
 *   over `sync_completed` rows, so a dropped event shows the user a stale
 *   timestamp.
 *
 * The app wires this to `@mongrov/analytics/sync`'s sensor sink. The device
 * package never imports the analytics engine — it only speaks the shared
 * `@mongrov/types/device-events` contract.
 *
 * Implementations should be non-blocking: a sync cycle must not stall on
 * event persistence.
 */
export interface DeviceEventSink {
  emit: <T extends DeviceEventType>(
    eventType: T,
    deviceId: string,
    payload: DeviceEventPayload<T>,
  ) => void
}
