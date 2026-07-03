/**
 * @mongrov/device — adapter + capability shape tests
 *
 * Uses the fake adapter to verify:
 *   - Default DeviceAdapter shape (ownership, capabilities, id)
 *   - Each capability satellite interface is structurally implementable
 *   - Ownership flag overrides behave as documented
 */

import type {
  BatchSyncCapability,
  DeviceAdapter,
  DeviceReading,
  FirmwareCapability,
  LiveStreamCapability,
  MeasureCapability,
  ScanCandidate,
} from '../index'

import { createFakeAdapter } from '../__mocks__/fake-adapter'

describe('DeviceAdapter (fake)', () => {
  it('defaults to id="fake", always-handle, full-driver reconnect, LiveStream+BatchSync', () => {
    const adapter = createFakeAdapter()

    expect(adapter.id).toBe('fake')
    expect(adapter.canHandle({ id: 'any' })).toBe(true)
    expect(adapter.ownership).toEqual({
      scan: true,
      reconnect: false,
      sync: false,
    })
    expect(adapter.capabilities.has('LiveStream')).toBe(true)
    expect(adapter.capabilities.has('BatchSync')).toBe(true)
    expect(adapter.capabilities.has('Measure')).toBe(false)
  })

  it('records connect + disconnect calls and mirrors connection-state events to subscribers', async () => {
    const adapter = createFakeAdapter()
    const events: Array<[string, string]> = []

    const unsub = adapter.onConnectionChange((id, state) => {
      events.push([id, state])
    })

    await adapter.connect('dev-1')
    adapter.emitConnectionChange('dev-1', 'ready')
    await adapter.disconnect('dev-1')
    adapter.emitConnectionChange('dev-1', 'idle')

    expect(adapter.connectCalls).toEqual(['dev-1'])
    expect(adapter.disconnectCalls).toEqual(['dev-1'])
    expect(events).toEqual([
      ['dev-1', 'ready'],
      ['dev-1', 'idle'],
    ])

    unsub()
    adapter.emitConnectionChange('dev-1', 'failed')
    expect(events).toHaveLength(2) // unsubscribed
  })

  it('honors ownership flag overrides (JCRing-style thin reflector)', () => {
    const jcringLike = createFakeAdapter({
      id: 'jcring',
      ownership: { scan: true, reconnect: true, sync: false },
      capabilities: ['BatchSync', 'Measure'],
    })

    expect(jcringLike.ownership.reconnect).toBe(true)
    expect(jcringLike.ownership.sync).toBe(false)
    expect(jcringLike.capabilities.has('LiveStream')).toBe(false)
    expect(jcringLike.capabilities.has('Measure')).toBe(true)
  })
})

describe('Capability satellite interfaces', () => {
  it('LiveStreamCapability is structurally implementable', () => {
    const cap: LiveStreamCapability = {
      subscribe(_id, _onReading) {
        return () => {}
      },
    }
    expect(typeof cap.subscribe).toBe('function')
  })

  it('BatchSyncCapability is structurally implementable', async () => {
    const cap: BatchSyncCapability = {
      async pull(_id, _metric, _cursor, onReading) {
        const reading: DeviceReading = {
          deviceId: 'd',
          metric: 'hr',
          kind: 'scalar',
          ts: 1,
          value: 60,
          receivedAt: 2,
        }
        onReading(reading)
        return { newCursor: 42 }
      },
    }
    const result = await cap.pull('d', 'hr', undefined, () => {})
    expect(result.newCursor).toBe(42)
  })

  it('MeasureCapability + FirmwareCapability are structurally implementable', async () => {
    const measure: MeasureCapability = {
      async startMeasurement(_id, _type, onProgress) {
        onProgress?.(50)
        onProgress?.(100)
        return []
      },
    }
    const fw: FirmwareCapability = {
      async getFirmwareInfo(_id) {
        return { version: '1.0.0', updateAvailable: false }
      },
      async applyUpdate(_id, onProgress) {
        onProgress(100)
      },
    }

    const results = await measure.startMeasurement('d', 'ppg')
    const info = await fw.getFirmwareInfo('d')

    expect(results).toEqual([])
    expect(info.version).toBe('1.0.0')
  })
})

describe('Scan handling', () => {
  it('startScan + emitScanCandidate delivers candidates to onFound', async () => {
    const adapter = createFakeAdapter()
    const candidates: ScanCandidate[] = []

    await adapter.startScan((c) => candidates.push(c))
    expect(adapter.isScanning()).toBe(true)

    adapter.emitScanCandidate({ id: 'aa:bb', rssi: -60 })
    adapter.emitScanCandidate({ id: 'cc:dd', rssi: -75 })

    expect(candidates).toEqual([
      { id: 'aa:bb', rssi: -60 },
      { id: 'cc:dd', rssi: -75 },
    ])

    await adapter.stopScan()
    expect(adapter.isScanning()).toBe(false)
  })
})

describe('DeviceAdapter type is assignable from the fake', () => {
  it('fake is structurally a DeviceAdapter', () => {
    const adapter: DeviceAdapter = createFakeAdapter()
    expect(adapter.id).toBeDefined()
  })
})
