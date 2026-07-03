/**
 * @mongrov/device — port contract tests
 *
 * Uses the fake implementations to verify that:
 *   - ReadingSink captures every write
 *   - ConfigStore round-trips cursors per (deviceId, metric)
 *   - DeviceLogger captures events
 *   - LifecyclePort notifies subscribers and unsubscribes
 *
 * Runtime behavior only — types are covered by the compile step.
 */

import type { DeviceDiagnosticEvent, DeviceReading } from '@mongrov/types'

import {
  createFakeConfigStore,
  createFakeLifecycle,
  createFakeLogger,
  createFakeReadingSink,
} from '../__mocks__/fake-ports'

describe('ReadingSink (fake)', () => {
  it('captures every write in order', async () => {
    const fake = createFakeReadingSink()

    const r1: DeviceReading = {
      deviceId: 'dev-1',
      metric: 'hr',
      kind: 'scalar',
      ts: 1_000,
      value: 72,
      receivedAt: 1_005,
    }
    const r2: DeviceReading = {
      deviceId: 'dev-1',
      metric: 'hr',
      kind: 'scalar',
      ts: 2_000,
      value: 73,
      receivedAt: 2_005,
    }

    await fake.sink.write(r1)
    await fake.sink.write(r2)

    expect(fake.writes).toHaveLength(2)
    expect(fake.writes[0]).toBe(r1)
    expect(fake.writes[1]).toBe(r2)

    fake.reset()
    expect(fake.writes).toHaveLength(0)
  })
})

describe('ConfigStore (fake)', () => {
  it('round-trips cursors keyed on (deviceId, metric)', async () => {
    const fake = createFakeConfigStore()

    // Missing key → undefined
    expect(await fake.store.getCursor('dev-1', 'hr')).toBeUndefined()

    // Set + read back
    await fake.store.setCursor('dev-1', 'hr', 1_700_000_000_000)
    expect(await fake.store.getCursor('dev-1', 'hr')).toBe(1_700_000_000_000)

    // Different device — independent
    await fake.store.setCursor('dev-2', 'hr', 1_800_000_000_000)
    expect(await fake.store.getCursor('dev-1', 'hr')).toBe(1_700_000_000_000)
    expect(await fake.store.getCursor('dev-2', 'hr')).toBe(1_800_000_000_000)

    // Different metric on the same device — independent
    await fake.store.setCursor('dev-1', 'spo2', 42)
    expect(await fake.store.getCursor('dev-1', 'hr')).toBe(1_700_000_000_000)
    expect(await fake.store.getCursor('dev-1', 'spo2')).toBe(42)

    fake.reset()
    expect(await fake.store.getCursor('dev-1', 'hr')).toBeUndefined()
  })
})

describe('DeviceLogger (fake)', () => {
  it('captures every event in order', () => {
    const fake = createFakeLogger()

    const e1: DeviceDiagnosticEvent = {
      deviceId: 'dev-1',
      adapterId: 'jcring',
      trigger: 'failed',
      phase: 'connecting',
      category: 'timeout',
      ts: 1_000,
    }
    const e2: DeviceDiagnosticEvent = {
      deviceId: 'dev-1',
      adapterId: 'jcring',
      trigger: 'reconnecting',
      phase: 'connected',
      category: 'unexpected-disconnect',
      ts: 2_000,
    }

    fake.logger.log(e1)
    fake.logger.log(e2)

    expect(fake.events).toHaveLength(2)
    expect(fake.events[0].trigger).toBe('failed')
    expect(fake.events[1].trigger).toBe('reconnecting')
  })
})

describe('LifecyclePort (fake)', () => {
  it('notifies subscribers of state changes and cleans up on unsubscribe', () => {
    const fake = createFakeLifecycle()

    const seenA: string[] = []
    const seenB: string[] = []

    const unsubA = fake.lifecycle.subscribe((s) => seenA.push(s))
    const unsubB = fake.lifecycle.subscribe((s) => seenB.push(s))
    expect(fake.subscriberCount()).toBe(2)

    fake.setState('background')
    fake.setState('foreground')

    expect(seenA).toEqual(['background', 'foreground'])
    expect(seenB).toEqual(['background', 'foreground'])

    unsubA()
    expect(fake.subscriberCount()).toBe(1)

    fake.setState('background')

    expect(seenA).toEqual(['background', 'foreground']) // no new entry
    expect(seenB).toEqual(['background', 'foreground', 'background'])

    unsubB()
    expect(fake.subscriberCount()).toBe(0)
  })
})
