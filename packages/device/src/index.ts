/**
 * @mongrov/device — headless BLE transport
 *
 * Zero UI, zero vendor SDK, zero db, zero ble-plx. Ships:
 *   - DeviceAdapter contract + capability interfaces (types.ts)
 *   - Behavioral ports the app must supply (ports.ts)
 *
 * Machines (connection, registry, sync) are internal implementation detail
 * and are exposed via `createDeviceClient()` in D5. XState never leaks.
 */

// Ports (behavioral contracts the app supplies)
export type {
  ConfigStore,
  DeviceEventSink,
  DeviceLogger,
  LifecyclePort,
  LifecycleState,
  LifecycleUnsubscribe,
  ReadingSink,
} from './ports'

// Sync lifecycle events (Sprint 5 T-39). The emitter is usable today; D5's
// sync machine wires it into its transitions.
export { createSyncEventEmitter } from './sync-events'
export type {
  Clock,
  SyncEventEmitter,
  SyncEventEmitterConfig,
  SyncRun,
} from './sync-events'

// Adapter contract + capability interfaces + re-exported data shapes
export type {
  AdapterOwnership,
  BatchSyncCapability,
  ConnectionChangeListener,
  ConnectionState,
  Device,
  DeviceAdapter,
  DeviceCapability,
  DeviceDiagnosticEvent,
  DeviceErrorCategory,
  DeviceReading,
  DeviceStatus,
  ErrorDetail,
  FirmwareCapability,
  JsonValue,
  LiveStreamCapability,
  MeasureCapability,
  ReadingKind,
  ScanCandidate,
  SyncStatus,
  Unsubscribe,
} from './types'
// Re-exported device-event contract so consumers need one import.
export {
  decodeDeviceEventPayload,
  DEVICE_EVENT_TYPES,
  encodeDeviceEventPayload,
} from '@mongrov/types/device-events'

export type {
  DeviceEventPayload,
  DeviceEventType,
  SyncTriggerValue,
} from '@mongrov/types/device-events'
