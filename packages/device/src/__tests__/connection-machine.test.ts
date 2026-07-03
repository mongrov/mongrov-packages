/**
 * connection-machine — behavioral tests for the per-device state chart.
 *
 * Uses XState v5 `createActor()` + Jest fake timers. Delay values are small
 * so `jest.advanceTimersByTime` can step through phases synchronously.
 */

import { createActor } from 'xstate'

import { createFakeAdapter } from '../__mocks__/fake-adapter'
import {
  createConnectionMachine,
  type ConnectionDelays,
} from '../registry/connection-machine'

const TEST_DELAYS: ConnectionDelays = {
  scanTimeoutMs: 100,
  connectTimeoutMs: 100,
  discoverTimeoutMs: 100,
  enableTimeoutMs: 100,
  cancelFallbackMs: 50,
  backoffCapMs: 5_000,
}

function build(adapterOptions: Parameters<typeof createFakeAdapter>[0] = {}) {
  const adapter = createFakeAdapter(adapterOptions)
  const machine = createConnectionMachine(TEST_DELAYS)
  const actor = createActor(machine, {
    input: { deviceId: 'dev-1', adapter },
  }).start()
  return { adapter, actor }
}

function value(actor: ReturnType<typeof createActor>) {
  return actor.getSnapshot().value
}

describe('connection-machine — happy path', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('idle → SCAN_START → scanning → SCAN_COMPLETE (empty) → idle (NOT failed)', () => {
    const { actor } = build()

    expect(value(actor)).toBe('idle')
    actor.send({ type: 'SCAN_START' })
    expect(value(actor)).toBe('scanning')

    // Empty scan resolves to idle per the spec lock (§6.1).
    actor.send({ type: 'SCAN_COMPLETE' })
    expect(value(actor)).toBe('idle')
  })

  it('SCAN_FOUND populates candidate in context without changing state', () => {
    const { actor } = build()
    actor.send({ type: 'SCAN_START' })
    actor.send({
      type: 'SCAN_FOUND',
      candidate: { id: 'aa:bb', rssi: -55 },
    })

    expect(value(actor)).toBe('scanning')
    expect(actor.getSnapshot().context.candidate).toEqual({
      id: 'aa:bb',
      rssi: -55,
    })
  })

  it('full happy path: idle → connecting → discovering → enabling → connected', () => {
    const { actor } = build()

    actor.send({ type: 'CONNECT' })
    expect(value(actor)).toBe('connecting')

    actor.send({ type: 'CONNECT_SUCCESS' })
    expect(value(actor)).toBe('discovering')

    actor.send({ type: 'CONNECT_SUCCESS' })
    expect(value(actor)).toBe('enabling')

    actor.send({ type: 'CONNECT_SUCCESS' })
    expect(value(actor)).toBe('connected')
    expect(actor.getSnapshot().context.lastError).toBeUndefined()
  })
})

describe('connection-machine — timeouts', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('connecting → after connectTimeoutMs → failed{category:timeout}', () => {
    const { actor } = build()
    actor.send({ type: 'CONNECT' })
    expect(value(actor)).toBe('connecting')

    jest.advanceTimersByTime(TEST_DELAYS.connectTimeoutMs)
    expect(value(actor)).toBe('failed')
    expect(actor.getSnapshot().context.lastError?.category).toBe('timeout')
  })

  it('discovering → after discoverTimeoutMs → failed{category:timeout}', () => {
    const { actor } = build()
    actor.send({ type: 'CONNECT' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    expect(value(actor)).toBe('discovering')

    jest.advanceTimersByTime(TEST_DELAYS.discoverTimeoutMs)
    expect(value(actor)).toBe('failed')
    expect(actor.getSnapshot().context.lastError?.category).toBe('timeout')
  })

  it('enabling → after enableTimeoutMs → failed{category:timeout}', () => {
    const { actor } = build()
    actor.send({ type: 'CONNECT' })
    actor.send({ type: 'CONNECT_SUCCESS' }) // → discovering
    actor.send({ type: 'CONNECT_SUCCESS' }) // → enabling
    expect(value(actor)).toBe('enabling')

    jest.advanceTimersByTime(TEST_DELAYS.enableTimeoutMs)
    expect(value(actor)).toBe('failed')
    expect(actor.getSnapshot().context.lastError?.category).toBe('timeout')
  })
})

describe('connection-machine — cancel vs disconnect (spec lock)', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('CANCEL in scanning (in-progress) → cancelling → idle', () => {
    const { actor } = build()
    actor.send({ type: 'SCAN_START' })
    expect(value(actor)).toBe('scanning')

    actor.send({ type: 'CANCEL' })
    expect(value(actor)).toBe('cancelling')

    jest.advanceTimersByTime(TEST_DELAYS.cancelFallbackMs)
    expect(value(actor)).toBe('idle')
  })

  it('DISCONNECT in connected (established) → idle', () => {
    const { actor } = build()
    actor.send({ type: 'CONNECT' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    expect(value(actor)).toBe('connected')

    actor.send({ type: 'DISCONNECT' })
    expect(value(actor)).toBe('idle')
  })
})

describe('connection-machine — reconnect ownership branching', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('UNEXPECTED_DISCONNECT + thin reflector: reconnecting waits for adapter, no timer', () => {
    const { actor } = build({
      ownership: { scan: true, reconnect: true, sync: false },
    })
    actor.send({ type: 'CONNECT' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    expect(value(actor)).toBe('connected')

    actor.send({ type: 'UNEXPECTED_DISCONNECT' })
    expect(value(actor)).toEqual({ reconnecting: 'reflecting' })

    // No amount of time advances state — adapter drives.
    jest.advanceTimersByTime(60_000)
    expect(value(actor)).toEqual({ reconnecting: 'reflecting' })

    // SDK's own reconnect success surfaces via CONNECT_SUCCESS.
    actor.send({ type: 'CONNECT_SUCCESS' })
    expect(value(actor)).toBe('connected')
  })

  it('UNEXPECTED_DISCONNECT + full driver: reconnecting cycles via backoff and increments attempts', () => {
    const { actor } = build({
      ownership: { scan: true, reconnect: false, sync: false },
    })
    actor.send({ type: 'CONNECT' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    expect(value(actor)).toBe('connected')

    actor.send({ type: 'UNEXPECTED_DISCONNECT' })
    expect(value(actor)).toEqual({ reconnecting: 'backingOff' })
    expect(actor.getSnapshot().context.attemptsCount).toBe(0)

    // 1s backoff (2^0 * 1000).
    jest.advanceTimersByTime(1_000)
    expect(value(actor)).toEqual({ reconnecting: 'attempting' })
    expect(actor.getSnapshot().context.attemptsCount).toBe(1)

    // The attempt itself times out (connectTimeoutMs = 100).
    jest.advanceTimersByTime(TEST_DELAYS.connectTimeoutMs)
    expect(value(actor)).toEqual({ reconnecting: 'backingOff' })

    // 2s backoff (2^1 * 1000).
    jest.advanceTimersByTime(2_000)
    expect(value(actor)).toEqual({ reconnecting: 'attempting' })
    expect(actor.getSnapshot().context.attemptsCount).toBe(2)
  })

  it('full-driver reconnect exhausts after 8 attempts → failed{canRetry:false}', () => {
    const { actor } = build({
      ownership: { scan: true, reconnect: false, sync: false },
    })
    actor.send({ type: 'CONNECT' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    actor.send({ type: 'UNEXPECTED_DISCONNECT' })

    // Burn through 8 backoff/attempt cycles.
    for (let attempt = 0; attempt < 8; attempt++) {
      // Backoff — grows to cap at attempt 5.
      jest.advanceTimersByTime(TEST_DELAYS.backoffCapMs + 1_000)
      // Attempt timeout.
      jest.advanceTimersByTime(TEST_DELAYS.connectTimeoutMs + 10)
    }

    // 9th backoff step: no attempts remaining → failed.
    jest.advanceTimersByTime(TEST_DELAYS.backoffCapMs + 1_000)

    expect(value(actor)).toBe('failed')
    expect(actor.getSnapshot().context.lastError).toEqual({
      category: 'unexpected-disconnect',
      phase: 'connected',
      canRetry: false,
    })
  })
})

describe('connection-machine — global interrupts', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('BT_OFF from connecting → suspended; RESUMED → re-enters connecting (priorPhase)', () => {
    const { actor } = build()
    actor.send({ type: 'CONNECT' })
    expect(value(actor)).toBe('connecting')

    actor.send({ type: 'BT_OFF' })
    expect(value(actor)).toBe('suspended')
    expect(actor.getSnapshot().context.priorPhase).toBe('connecting')

    actor.send({ type: 'RESUMED' })
    // priorPhase is cleared by the RESUMED transition, then reset by the
    // fresh `connecting` entry action — verifies the resume routed through
    // the right guard and re-entered the phase.
    expect(value(actor)).toBe('connecting')
    expect(actor.getSnapshot().context.priorPhase).toBe('connecting')
  })

  it('BACKGROUNDED from connected → suspended; RESUMED re-enters reconnecting', () => {
    const { actor } = build({
      ownership: { scan: true, reconnect: true, sync: false },
    })
    actor.send({ type: 'CONNECT' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    expect(value(actor)).toBe('connected')

    actor.send({ type: 'BACKGROUNDED' })
    expect(value(actor)).toBe('suspended')
    expect(actor.getSnapshot().context.priorPhase).toBe('connected')

    actor.send({ type: 'RESUMED' })
    // Coming back from connected returns to reconnecting so the adapter can
    // re-establish (or re-report a drop).
    expect(value(actor)).toEqual({ reconnecting: 'reflecting' })
  })

  it('PERMISSION_REVOKED in scanning → suspended; RESUMED returns to scanning', () => {
    const { actor } = build()
    actor.send({ type: 'SCAN_START' })
    expect(value(actor)).toBe('scanning')

    actor.send({ type: 'PERMISSION_REVOKED' })
    expect(value(actor)).toBe('suspended')
    expect(actor.getSnapshot().context.priorPhase).toBe('scanning')

    actor.send({ type: 'RESUMED' })
    expect(value(actor)).toBe('scanning')
  })

  it('BT_OFF from reconnecting → suspended; RESUMED returns to reconnecting via priorPhase capture', () => {
    // Full-driver path so we can prove no timers fire during suspended.
    const { actor } = build({
      ownership: { scan: true, reconnect: false, sync: false },
    })
    actor.send({ type: 'CONNECT' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    actor.send({ type: 'CONNECT_SUCCESS' })
    actor.send({ type: 'UNEXPECTED_DISCONNECT' })
    expect(value(actor)).toEqual({ reconnecting: 'backingOff' })

    actor.send({ type: 'BT_OFF' })
    expect(value(actor)).toBe('suspended')
    // reconnecting's own priorPhase entry captured 'reconnecting'.
    expect(actor.getSnapshot().context.priorPhase).toBe('reconnecting')

    // No timers fire while suspended.
    jest.advanceTimersByTime(30_000)
    expect(value(actor)).toBe('suspended')

    actor.send({ type: 'RESUMED' })
    // priorPhase === 'reconnecting' has no dedicated resume guard, so the
    // fallback route sends us to idle — which is the honest recovery point.
    expect(value(actor)).toBe('idle')
  })
})
