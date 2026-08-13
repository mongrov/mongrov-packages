/**
 * Sprint 5 T-39 — typed sync lifecycle events.
 *
 * These events are data, not diagnostics: `device.lastSyncedAt` (the
 * "Updated N min ago" label) is a query over `sync_completed` rows, so the
 * payload shape and the no-double-settle guarantee are user-visible.
 */

import type { DeviceEventType } from '@mongrov/types/device-events'

import type { DeviceEventSink } from '../ports'
import {
  DEVICE_EVENT_PAYLOAD_SCHEMAS,

} from '@mongrov/types/device-events'
import { createSyncEventEmitter } from '../sync-events'

interface Emitted {
  eventType: DeviceEventType
  deviceId: string
  payload: unknown
}

function recordingSink() {
  const emitted: Emitted[] = []
  const sink: DeviceEventSink = {
    emit(eventType, deviceId, payload) {
      emitted.push({ eventType, deviceId, payload })
    },
  }
  return { sink, emitted }
}

/** Advanceable clock so latency assertions need no timers. */
function fakeClock(start = 1_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('beginSync', () => {
  it('emits sync_started with the trigger', () => {
    const { sink, emitted } = recordingSink()
    const emitter = createSyncEventEmitter({ sink })

    emitter.beginSync('ring_1', 'background')

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      eventType: 'sync_started',
      deviceId: 'ring_1',
      payload: { trigger: 'background' },
    })
  })

  it('emits sync_completed with measured latency', () => {
    const { sink, emitted } = recordingSink()
    const clock = fakeClock()
    const emitter = createSyncEventEmitter({ sink, now: clock.now })

    const run = emitter.beginSync('ring_1', 'manual')
    clock.advance(1830)
    run.complete(412)

    expect(emitted[1]).toMatchObject({
      eventType: 'sync_completed',
      deviceId: 'ring_1',
      payload: { trigger: 'manual', rowsWritten: 412, latencyMs: 1830 },
    })
  })

  it('treats rowsWritten 0 as a real completion', () => {
    // A cycle that found nothing new still completed; the freshness label
    // should still advance rather than showing a stale timestamp.
    const { sink, emitted } = recordingSink()
    const emitter = createSyncEventEmitter({ sink })

    emitter.beginSync('ring_1', 'auto').complete(0)

    expect(emitted[1].eventType).toBe('sync_completed')
    expect((emitted[1].payload as { rowsWritten: number }).rowsWritten).toBe(0)
  })

  it('emits sync_failed with a readable error and retry count', () => {
    const { sink, emitted } = recordingSink()
    const emitter = createSyncEventEmitter({ sink })

    emitter.beginSync('ring_1', 'background').fail(new Error('BLE timeout'), 2)

    expect(emitted[1]).toMatchObject({
      eventType: 'sync_failed',
      payload: { trigger: 'background', error: 'BLE timeout', retryCount: 2 },
    })
  })

  it.each([
    ['string throwable', 'disconnected', 'disconnected'],
    ['object throwable', { code: 42 }, '{"code":42}'],
  ])('normalizes a %s', (_label, thrown, expected) => {
    const { sink, emitted } = recordingSink()
    createSyncEventEmitter({ sink }).beginSync('ring_1', 'auto').fail(thrown)
    expect((emitted[1].payload as { error: string }).error).toBe(expected)
  })

  it('defaults retryCount to 0', () => {
    const { sink, emitted } = recordingSink()
    createSyncEventEmitter({ sink }).beginSync('ring_1', 'auto').fail('x')
    expect((emitted[1].payload as { retryCount: number }).retryCount).toBe(0)
  })
})

describe('settle guarantees', () => {
  it('emits exactly one terminal event per run', () => {
    // A double-settle would double-count in any downstream tally.
    const { sink, emitted } = recordingSink()
    const run = createSyncEventEmitter({ sink }).beginSync('ring_1', 'auto')

    run.complete(10)
    run.complete(20)
    run.fail('late failure')

    const terminal = emitted.filter(e => e.eventType !== 'sync_started')
    expect(terminal).toHaveLength(1)
    expect(terminal[0].eventType).toBe('sync_completed')
  })

  it('a failure after completion does not overwrite it', () => {
    const { sink, emitted } = recordingSink()
    const run = createSyncEventEmitter({ sink }).beginSync('ring_1', 'auto')
    run.fail('boom')
    run.complete(5)

    expect(emitted.filter(e => e.eventType === 'sync_completed')).toHaveLength(0)
  })

  it('reports settled state', () => {
    const { sink } = recordingSink()
    const run = createSyncEventEmitter({ sink }).beginSync('ring_1', 'auto')
    expect(run.settled).toBe(false)
    run.complete(1)
    expect(run.settled).toBe(true)
  })

  it('never reports negative latency', () => {
    // Guards against a clock that steps backwards (NTP correction).
    const { sink, emitted } = recordingSink()
    let t = 5_000
    const run = createSyncEventEmitter({ sink, now: () => t })
      .beginSync('ring_1', 'auto')
    t = 4_000
    run.complete(1)
    expect((emitted[1].payload as { latencyMs: number }).latencyMs).toBe(0)
  })

  it('tracks concurrent runs independently', () => {
    const { sink, emitted } = recordingSink()
    const emitter = createSyncEventEmitter({ sink })

    const a = emitter.beginSync('ring_1', 'auto')
    const b = emitter.beginSync('ring_2', 'manual')
    b.complete(3)
    a.fail('timeout')

    expect(emitted.map(e => `${e.deviceId}:${e.eventType}`)).toEqual([
      'ring_1:sync_started',
      'ring_2:sync_started',
      'ring_2:sync_completed',
      'ring_1:sync_failed',
    ])
  })
})

describe('payloads satisfy the shared schema contract', () => {
  it('every emitted payload parses against DEVICE_EVENT_PAYLOAD_SCHEMAS', () => {
    // The whole point of routing through @mongrov/types: what the device
    // emits is exactly what the analytics engine will accept.
    const { sink, emitted } = recordingSink()
    const emitter = createSyncEventEmitter({ sink })

    emitter.beginSync('ring_1', 'auto').complete(7)
    emitter.beginSync('ring_2', 'background').fail(new Error('nope'), 1)

    expect(emitted).toHaveLength(4)
    for (const e of emitted) {
      expect(() => DEVICE_EVENT_PAYLOAD_SCHEMAS[e.eventType].parse(e.payload))
        .not
        .toThrow()
    }
  })
})
