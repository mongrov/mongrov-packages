# @mongrov/device

Headless BLE device transport for React Native / Expo apps: the contract a
device adapter implements, the ports the app supplies, and typed device
lifecycle events. No UI, no vendor SDK, no database, no BLE library.

The package is domain-free. A reading's `metric` is an open string and its
`value` is opaque JSON: what a device measures, and how it is stored, belong
to the app (or a domain pack), not here.

Status: **0.2.x**. The connection and registry machines are internal and not
exported yet; the public surface is the adapter contract, the ports and the
sync event emitter.

## Install

```bash
pnpm add @mongrov/device @mongrov/types
```

`react` and `react-native` are optional peers.

## Adapter contract

A `DeviceAdapter` wraps one family of devices — a GATT profile or a vendor's
SDK — behind one interface:

```ts
import type { DeviceAdapter, LiveStreamCapability } from '@mongrov/device'

export const bandAdapter: DeviceAdapter & LiveStreamCapability = {
  id: 'acme-band',
  canHandle: candidate => candidate.name?.startsWith('ACME') ?? false,
  // Which lifecycle concerns the adapter owns; the machines drive the rest.
  ownership: { scan: false, reconnect: false, sync: false },
  capabilities: new Set(['LiveStream']),
  async connect(deviceId) { /* … */ },
  async disconnect(deviceId) { /* … */ },
  onConnectionChange(listener) { /* map vendor states to ConnectionState */ return () => {} },
  subscribe(deviceId, onReading) { /* emit DeviceReading values */ return () => {} },
}
```

| Capability | Interface | What it adds |
|---|---|---|
| `LiveStream` | `LiveStreamCapability` | `subscribe(deviceId, onReading)` while connected |
| `BatchSync` | `BatchSyncCapability` | `pull(deviceId, metric, sinceCursor, onReading)` → `{ newCursor }`; drains the on-device buffer |
| `Measure` | `MeasureCapability` | `startMeasurement(deviceId, type, onProgress?)` → the readings of one session |
| `Firmware` | `FirmwareCapability` | `getFirmwareInfo(deviceId)`, `applyUpdate(deviceId, onProgress)` |

`ownership` decides who drives what: `scan: true` means the adapter runs its
own scanner (`startScan` / `stopScan`); `reconnect: true` means the adapter
reconnects itself and the connection machine only mirrors
`onConnectionChange`; `sync: true` means the adapter schedules its own sync.
Adapters pass native error detail through `ErrorDetail` rather than collapsing
every failure to "disconnected".

Data shapes (`Device`, `DeviceReading`, `ConnectionState`, `ErrorDetail`,
`ScanCandidate`, `DeviceCapability`, …) come from `@mongrov/types` and are
re-exported here, so one import is enough.

## Ports the app supplies

| Port | Shape | Used for |
|---|---|---|
| `ReadingSink` | `write(reading)` | where readings go (the app's store or sync pipeline) |
| `ConfigStore` | `getCursor` / `setCursor(deviceId, metric, cursor)` | `BatchSync` cursors |
| `DeviceLogger` | `log(event: DeviceDiagnosticEvent)` | typed diagnostics |
| `LifecyclePort` | `subscribe(listener: 'foreground' \| 'background')` | app foreground / background |
| `DeviceEventSink` | `emit(eventType, deviceId, payload)` | typed device lifecycle events |

## Device lifecycle events

`DEVICE_EVENT_TYPES`, `encodeDeviceEventPayload` and
`decodeDeviceEventPayload` are re-exported from
`@mongrov/types/device-events`: pairing, connection, battery, firmware update
and sync events, each with a validated payload. `createSyncEventEmitter`
emits a well-formed `sync_started` → `sync_completed` / `sync_failed` run:

```ts
import { createSyncEventEmitter } from '@mongrov/device'

const events = createSyncEventEmitter({ sink: deviceEventSink })

const run = events.beginSync('device_1', 'manual')
try {
  const rows = await pullEverything()
  run.complete(rows) // stamps latencyMs
}
catch (err) {
  run.fail(err)
}
```

A run settles once; a second `complete` or `fail` is ignored.

## License

MIT
