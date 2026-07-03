/**
 * Test-only helper: an in-memory DeviceAdapter for machine tests.
 *
 * Not a Jest auto-mock — tests import this explicitly. Provides synchronous
 * event triggers (`emitConnectionChange`, `emitScanCandidate`) so tests can
 * step through machine transitions without timers.
 */

import type {
  ConnectionChangeListener,
  ConnectionState,
  DeviceAdapter,
  DeviceCapability,
  ErrorDetail,
  ScanCandidate,
  Unsubscribe,
} from '../types'

export interface FakeAdapter extends DeviceAdapter {
  /** Fire a normalized connection-state change to every subscriber. */
  emitConnectionChange(
    deviceId: string,
    state: ConnectionState,
    detail?: ErrorDetail,
  ): void

  /** Fire a scan candidate to every active scanner. */
  emitScanCandidate(candidate: ScanCandidate): void

  /** Recorded connect() invocations, in order. */
  connectCalls: string[]

  /** Recorded disconnect() invocations, in order. */
  disconnectCalls: string[]

  /** Whether a scan is currently active. */
  isScanning(): boolean
}

export interface FakeAdapterOptions {
  id?: string
  canHandle?: (candidate: ScanCandidate) => boolean
  ownership?: Partial<DeviceAdapter['ownership']>
  capabilities?: DeviceCapability[]
}

/**
 * Build a fake DeviceAdapter for tests. Defaults to `id: 'fake'`, always-handle,
 * full-driver reconnect (ownership.reconnect === false), LiveStream + BatchSync
 * capabilities.
 */
export function createFakeAdapter(options: FakeAdapterOptions = {}): FakeAdapter {
  const listeners = new Set<ConnectionChangeListener>()
  const scanners = new Set<(c: ScanCandidate) => void>()
  const connectCalls: string[] = []
  const disconnectCalls: string[] = []
  let scanning = false

  const adapter: FakeAdapter = {
    id: options.id ?? 'fake',
    canHandle: options.canHandle ?? (() => true),
    ownership: {
      scan: options.ownership?.scan ?? true,
      reconnect: options.ownership?.reconnect ?? false,
      sync: options.ownership?.sync ?? false,
    },
    capabilities: new Set<DeviceCapability>(
      options.capabilities ?? ['LiveStream', 'BatchSync'],
    ),

    async connect(deviceId: string): Promise<void> {
      connectCalls.push(deviceId)
    },

    async disconnect(deviceId: string): Promise<void> {
      disconnectCalls.push(deviceId)
    },

    onConnectionChange(listener: ConnectionChangeListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async startScan(onFound: (c: ScanCandidate) => void): Promise<void> {
      scanners.add(onFound)
      scanning = true
    },

    async stopScan(): Promise<void> {
      scanners.clear()
      scanning = false
    },

    emitConnectionChange(deviceId, state, detail) {
      for (const listener of listeners) {
        listener(deviceId, state, detail)
      }
    },

    emitScanCandidate(candidate) {
      for (const onFound of scanners) {
        onFound(candidate)
      }
    },

    connectCalls,
    disconnectCalls,

    isScanning(): boolean {
      return scanning
    },
  }

  return adapter
}
