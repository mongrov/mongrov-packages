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

// Ports (behavioral contracts the app supplies)
export type {
  ConfigStore,
  DeviceLogger,
  LifecyclePort,
  LifecycleState,
  LifecycleUnsubscribe,
  ReadingSink,
} from './ports'
