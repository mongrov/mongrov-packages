/**
 * registry-machine — behavioral tests for the parent that spawns per-device
 * connection actors, enforces the shared-slot pool, aggregates scans, and
 * broadcasts global interrupts.
 */

import type { FakeAdapter } from '../__mocks__/fake-adapter'

import { createActor } from 'xstate'
import { createFakeAdapter } from '../__mocks__/fake-adapter'
import { createConnectionMachine } from '../registry/connection-machine'
import { createRegistryMachine } from '../registry/registry-machine'

const CONNECTION_DELAYS = {
  scanTimeoutMs: 100,
  connectTimeoutMs: 100,
  discoverTimeoutMs: 100,
  enableTimeoutMs: 100,
  cancelFallbackMs: 50,
  backoffCapMs: 5_000,
}

function build(
  adapters: FakeAdapter[],
  opts: { maxConnections?: number } = {},
) {
  const machine = createRegistryMachine(CONNECTION_DELAYS)
  const actor = createActor(machine, {
    input: {
      adapters,
      maxConnections: opts.maxConnections,
      connectionDelays: CONNECTION_DELAYS,
    },
  }).start()
  return actor
}

// ─── Scan fanout & aggregation ────────────────────────────────────────────

describe('registry — scan fanout & aggregation', () => {
  it('SCAN_START fans out only to adapters with ownership.scan === true', async () => {
    const scanA = createFakeAdapter({ id: 'A', ownership: { scan: true } })
    const scanB = createFakeAdapter({ id: 'B', ownership: { scan: false } })
    const scanCStartSpy = jest.fn(async () => {})
    const scanC = createFakeAdapter({ id: 'C', ownership: { scan: true } })
    scanC.startScan = scanCStartSpy

    const registry = build([scanA, scanB, scanC])
    registry.send({ type: 'SCAN_START' })

    // Give the microtask queue a chance to run any spawned promises.
    await Promise.resolve()

    expect(scanA.isScanning()).toBe(true)
    expect(scanB.isScanning()).toBe(false)
    expect(scanCStartSpy).toHaveBeenCalledTimes(1)
    expect(registry.getSnapshot().context.scanState).toBe('scanning')
  })

  it('SCAN_HIT aggregates candidates from all adapters into scanCandidates', () => {
    const a1 = createFakeAdapter({ id: 'A' })
    const a2 = createFakeAdapter({ id: 'B' })
    const registry = build([a1, a2])

    registry.send({
      type: 'SCAN_HIT',
      candidate: { id: 'aa:bb', rssi: -60 },
    })
    registry.send({
      type: 'SCAN_HIT',
      candidate: { id: 'cc:dd', rssi: -70 },
    })

    const candidates = registry.getSnapshot().context.scanCandidates
    expect(candidates.size).toBe(2)
    expect(candidates.get('aa:bb')).toEqual({ id: 'aa:bb', rssi: -60 })
    expect(candidates.get('cc:dd')).toEqual({ id: 'cc:dd', rssi: -70 })
  })

  it('canHandle routing: SCAN_HIT is only recorded when at least one adapter claims it', () => {
    const claiming = createFakeAdapter({
      id: 'jcring',
      canHandle: c => c.id.startsWith('jc:'),
    })
    const rejecting = createFakeAdapter({
      id: 'gatt',
      canHandle: () => false,
    })
    const registry = build([claiming, rejecting])

    registry.send({
      type: 'SCAN_HIT',
      candidate: { id: 'jc:01', rssi: -55 },
    })
    registry.send({
      type: 'SCAN_HIT',
      candidate: { id: 'other:01', rssi: -55 },
    })

    const candidates = registry.getSnapshot().context.scanCandidates
    expect(candidates.size).toBe(1)
    expect(candidates.get('jc:01')).toBeDefined()
    expect(candidates.get('other:01')).toBeUndefined()
  })
})

// ─── Actor spawning & connect forwarding ─────────────────────────────────

describe('registry — connect actor lifecycle', () => {
  it('CONNECT_REQUEST spawns a connection actor and forwards CONNECT', () => {
    const adapter = createFakeAdapter()
    const registry = build([adapter])

    registry.send({ type: 'CONNECT_REQUEST', deviceId: 'dev-1' })

    const ctx = registry.getSnapshot().context
    expect(ctx.connectionActors.has('dev-1')).toBe(true)
    expect(ctx.activeConnections).toBe(1)

    const child = ctx.connectionActors.get('dev-1')!
    // Forwarded CONNECT drove the child out of `idle`.
    expect(child.getSnapshot().value).toBe('connecting')
  })

  it('duplicate CONNECT_REQUEST for same deviceId does NOT spawn a second actor', () => {
    const adapter = createFakeAdapter()
    const registry = build([adapter])

    registry.send({ type: 'CONNECT_REQUEST', deviceId: 'dev-1' })
    const firstActor = registry
      .getSnapshot()
      .context
      .connectionActors
      .get('dev-1')

    registry.send({ type: 'CONNECT_REQUEST', deviceId: 'dev-1' })
    const secondActor = registry
      .getSnapshot()
      .context
      .connectionActors
      .get('dev-1')

    expect(firstActor).toBe(secondActor)
    expect(registry.getSnapshot().context.activeConnections).toBe(1)
  })
})

// ─── Slot cap enforcement ─────────────────────────────────────────────────

describe('registry — shared connection pool (maxConnections)', () => {
  it('rejects with slot-full when the pool is saturated (no spawn, no throw)', () => {
    const adapter = createFakeAdapter()
    const registry = build([adapter], { maxConnections: 2 })

    registry.send({ type: 'CONNECT_REQUEST', deviceId: 'dev-1' })
    registry.send({ type: 'CONNECT_REQUEST', deviceId: 'dev-2' })
    expect(registry.getSnapshot().context.activeConnections).toBe(2)

    registry.send({ type: 'CONNECT_REQUEST', deviceId: 'dev-3' })

    const ctx = registry.getSnapshot().context
    expect(ctx.connectionActors.has('dev-3')).toBe(false)
    expect(ctx.activeConnections).toBe(2)
    expect(ctx.lastRejection).toEqual({
      category: 'slot-full',
      phase: 'connect-request',
      canRetry: true,
    })
  })

  it('slot frees when a child transitions to idle; next CONNECT_REQUEST succeeds', () => {
    const adapter = createFakeAdapter()
    const registry = build([adapter], { maxConnections: 1 })

    registry.send({ type: 'CONNECT_REQUEST', deviceId: 'dev-1' })
    expect(registry.getSnapshot().context.activeConnections).toBe(1)

    // Child returned to idle (e.g. after DISCONNECT or terminal failure the
    // app acknowledged). Registry reaps it.
    registry.send({
      type: 'CONNECTION_STATE_CHANGED',
      deviceId: 'dev-1',
      state: 'idle',
    })

    expect(registry.getSnapshot().context.activeConnections).toBe(0)
    expect(
      registry.getSnapshot().context.connectionActors.has('dev-1'),
    ).toBe(false)

    // Second device can now claim the freed slot.
    registry.send({ type: 'CONNECT_REQUEST', deviceId: 'dev-2' })
    expect(
      registry.getSnapshot().context.connectionActors.has('dev-2'),
    ).toBe(true)
  })
})

// ─── Global interrupt broadcast ──────────────────────────────────────────

describe('registry — global interrupt broadcast', () => {
  it('BT_OFF broadcasts to every connection actor (each captures priorPhase)', () => {
    const adapter = createFakeAdapter()
    const registry = build([adapter], { maxConnections: 5 })

    registry.send({ type: 'CONNECT_REQUEST', deviceId: 'dev-1' })
    registry.send({ type: 'CONNECT_REQUEST', deviceId: 'dev-2' })

    const child1 = registry.getSnapshot().context.connectionActors.get('dev-1')!
    const child2 = registry.getSnapshot().context.connectionActors.get('dev-2')!
    expect(child1.getSnapshot().value).toBe('connecting')
    expect(child2.getSnapshot().value).toBe('connecting')

    registry.send({ type: 'BT_OFF' })

    expect(child1.getSnapshot().value).toBe('suspended')
    expect(child2.getSnapshot().value).toBe('suspended')
    expect(child1.getSnapshot().context.priorPhase).toBe('connecting')
    expect(child2.getSnapshot().context.priorPhase).toBe('connecting')

    // Sanity: unused connection-machine factory export stays importable.
    expect(typeof createConnectionMachine).toBe('function')
  })
})
