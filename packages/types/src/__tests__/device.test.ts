/**
 * Type-level compile tests for @mongrov/types device additions (v0.4.0)
 *
 * These tests verify device type shapes at compile + runtime.
 * If TypeScript compiles and Jest passes, the types are valid.
 */

import type {
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
} from '../index'

// ─── Device ────────────────────────────────────────────────────────────────

describe('Device', () => {
  it('should create valid Device for each ConnectionState', () => {
    const states: ConnectionState[] = [
      'idle',
      'scanning',
      'connecting',
      'discovering',
      'ready',
      'reconnecting',
      'disconnecting',
      'suspended',
      'failed',
    ]

    for (const state of states) {
      const device: Device = {
        id: 'dev-1',
        adapterId: 'jcring',
        state,
      }
      expect(device.state).toBe(state)
    }

    expect(states).toHaveLength(9)
  })

  it('should support all optional Device fields', () => {
    const device: Device = {
      id: 'dev-2',
      adapterId: 'gatt-generic',
      name: 'Ring #42',
      kind: 'ring',
      state: 'ready',
      rssi: -55,
      owned: true,
    }
    expect(device.name).toBe('Ring #42')
    expect(device.owned).toBe(true)
    expect(device.rssi).toBe(-55)
  })
})

// ─── DeviceReading + ReadingKind + JsonValue ───────────────────────────────

describe('DeviceReading', () => {
  it('should support all ReadingKind values', () => {
    const kinds: ReadingKind[] = ['scalar', 'vector', 'geo', 'sample', 'blob']
    expect(kinds).toHaveLength(5)
  })

  it('should accept scalar payload', () => {
    const reading: DeviceReading = {
      deviceId: 'dev-1',
      metric: 'hr',
      kind: 'scalar',
      ts: 1_700_000_000_000,
      value: 72,
      unit: 'bpm',
      receivedAt: 1_700_000_000_050,
      tags: { source: 'live' },
    }
    expect(reading.value).toBe(72)
    expect(reading.tags?.source).toBe('live')
  })

  it('should accept vector payload', () => {
    const reading: DeviceReading = {
      deviceId: 'dev-1',
      metric: 'accel',
      kind: 'vector',
      ts: 1_700_000_000_000,
      value: [0.01, -0.02, 0.98],
      receivedAt: 1_700_000_000_050,
    }
    expect(Array.isArray(reading.value)).toBe(true)
  })

  it('should accept geo payload', () => {
    const reading: DeviceReading = {
      deviceId: 'tracker-9',
      metric: 'location',
      kind: 'geo',
      ts: 1_700_000_000_000,
      value: { lat: 40.7128, lng: -74.006, alt: 10 },
      unit: 'm',
      receivedAt: 1_700_000_000_050,
    }
    expect(typeof reading.value).toBe('object')
  })

  it('should accept sample payload', () => {
    const reading: DeviceReading = {
      deviceId: 'dev-1',
      metric: 'ppg',
      kind: 'sample',
      ts: 1_700_000_000_000,
      value: [0.12, 0.15, 0.19, 0.22],
      seq: 42,
      receivedAt: 1_700_000_000_050,
      tags: { source: 'measure', window: 100 },
    }
    expect(reading.seq).toBe(42)
    expect(reading.tags?.source).toBe('measure')
  })

  it('should accept blob payload', () => {
    const reading: DeviceReading = {
      deviceId: 'dev-1',
      metric: 'sleep',
      kind: 'blob',
      ts: 1_700_000_000_000,
      value: { stages: ['deep', 'rem', 'light'], durations: [3600, 1800, 5400] },
      receivedAt: 1_700_000_000_050,
      tags: { source: 'backlog' },
    }
    expect(reading.tags?.source).toBe('backlog')
  })

  it('should accept all JsonValue shapes', () => {
    const values: JsonValue[] = [
      'string',
      42,
      true,
      null,
      [1, 2, 3],
      { nested: { deep: [1, null, 'x'] } },
    ]
    expect(values).toHaveLength(6)
  })
})

// ─── ErrorDetail + DeviceErrorCategory ─────────────────────────────────────

describe('ErrorDetail', () => {
  it('should create valid ErrorDetail for each DeviceErrorCategory', () => {
    const categories: DeviceErrorCategory[] = [
      'timeout',
      'out-of-range',
      'rejected',
      'slot-full',
      'bluetooth-off',
      'permission-denied',
      'backgrounded',
      'unexpected-disconnect',
      'unknown',
    ]

    for (const category of categories) {
      const detail: ErrorDetail = {
        category,
        phase: 'connecting',
        canRetry: category !== 'permission-denied',
      }
      expect(detail.category).toBe(category)
    }

    expect(categories).toHaveLength(9)
  })

  it('should support all optional ErrorDetail fields', () => {
    const detail: ErrorDetail = {
      category: 'unexpected-disconnect',
      phase: 'connected',
      canRetry: true,
      recoveryActions: ['toggle-bluetooth', 'move-closer'],
      nativeCode: 147,
      nativeMessage: 'GATT_ERROR',
    }
    expect(detail.recoveryActions).toHaveLength(2)
    expect(detail.nativeCode).toBe(147)
  })
})

// ─── DeviceStatus + DeviceCapability ───────────────────────────────────────

describe('DeviceStatus', () => {
  it('should support all DeviceCapability values', () => {
    const caps: DeviceCapability[] = ['LiveStream', 'BatchSync', 'Measure', 'Firmware']
    const status: DeviceStatus = {
      deviceId: 'dev-1',
      batteryPct: 85,
      firmwareVersion: '1.2.3',
      capabilities: caps,
      lastSeenAt: 1_700_000_000_000,
    }
    expect(status.capabilities).toEqual(caps)
    expect(caps).toHaveLength(4)
  })

  it('should support minimal DeviceStatus', () => {
    const status: DeviceStatus = {
      deviceId: 'dev-2',
      capabilities: [],
    }
    expect(status.capabilities).toEqual([])
    expect(status.batteryPct).toBeUndefined()
  })
})

// ─── DeviceDiagnosticEvent ─────────────────────────────────────────────────

describe('DeviceDiagnosticEvent', () => {
  it('should support each trigger value', () => {
    const triggers: DeviceDiagnosticEvent['trigger'][] = [
      'failed',
      'reconnecting',
      'suspended',
      'resumed',
      'sync-failed',
    ]

    for (const trigger of triggers) {
      const event: DeviceDiagnosticEvent = {
        deviceId: 'dev-1',
        adapterId: 'jcring',
        trigger,
        phase: 'connecting',
        category: 'timeout',
        ts: 1_700_000_000_000,
      }
      expect(event.trigger).toBe(trigger)
    }

    expect(triggers).toHaveLength(5)
  })

  it('should carry full native detail', () => {
    const event: DeviceDiagnosticEvent = {
      deviceId: 'dev-1',
      adapterId: 'gatt-generic',
      trigger: 'failed',
      phase: 'discovering',
      category: 'unexpected-disconnect',
      rssi: -85,
      attempt: 3,
      durationMs: 12_450,
      nativeCode: 147,
      nativeMessage: 'GATT_ERROR',
      ts: 1_700_000_000_000,
    }
    expect(event.attempt).toBe(3)
    expect(event.nativeCode).toBe(147)
  })
})

// ─── ScanCandidate ─────────────────────────────────────────────────────────

describe('ScanCandidate', () => {
  it('should support minimal ScanCandidate', () => {
    const c: ScanCandidate = { id: 'aa:bb:cc:dd:ee:ff' }
    expect(c.id).toBe('aa:bb:cc:dd:ee:ff')
  })

  it('should support fully-populated ScanCandidate', () => {
    const c: ScanCandidate = {
      id: 'aa:bb:cc:dd:ee:ff',
      name: 'Ring-42',
      rssi: -60,
      manufacturerData: 'ff0102030405',
      serviceUUIDs: ['180d', '180f'],
      adapterId: 'jcring',
    }
    expect(c.serviceUUIDs).toHaveLength(2)
    expect(c.adapterId).toBe('jcring')
  })
})

// ─── SyncStatus ────────────────────────────────────────────────────────────

describe('SyncStatus', () => {
  it('should have correct SyncStatus values', () => {
    const statuses: SyncStatus[] = ['idle', 'pulling', 'draining', 'failed', 'cancelled']
    expect(statuses).toHaveLength(5)
  })
})
