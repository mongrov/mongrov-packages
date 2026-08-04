/**
 * Sprint 5 T-04 — DEVICE_EVENT_TYPES + payload schemas.
 *
 * `device_event.payload` is a VARCHAR of serialized JSON, so the database
 * enforces nothing about it. These schemas are the enforcement, and this
 * suite is what keeps them honest.
 */

import { describe, expect, it } from 'vitest'

import {
  decodeDeviceEventPayload,
  DEVICE_EVENT_PAYLOAD_SCHEMAS,
  DEVICE_EVENT_TYPES,
  encodeDeviceEventPayload,
  isDeviceEventType,
} from '../device-events'

describe('DEVICE_EVENT_TYPES', () => {
  it('lists every event type named in the Sprint 5 spec', () => {
    expect([...DEVICE_EVENT_TYPES]).toEqual([
      'paired',
      'unpaired',
      'connected',
      'disconnected',
      'battery_sample',
      'battery_low',
      'firmware_updated',
      'sync_started',
      'sync_completed',
      'sync_failed',
    ])
  })

  it('has a payload schema for every type — no unschematised events', () => {
    for (const type of DEVICE_EVENT_TYPES) {
      expect(DEVICE_EVENT_PAYLOAD_SCHEMAS[type]).toBeDefined()
    }
    expect(Object.keys(DEVICE_EVENT_PAYLOAD_SCHEMAS).sort())
      .toEqual([...DEVICE_EVENT_TYPES].sort())
  })

  it('narrows unknown strings', () => {
    expect(isDeviceEventType('sync_completed')).toBe(true)
    expect(isDeviceEventType('sync_complete')).toBe(false)
    expect(isDeviceEventType('')).toBe(false)
  })
})

describe('payload round-trips', () => {
  it('encodes + decodes sync_completed, the "Updated N min ago" source', () => {
    const encoded = encodeDeviceEventPayload('sync_completed', {
      trigger: 'background',
      rowsWritten: 412,
      latencyMs: 1830,
    })
    expect(decodeDeviceEventPayload('sync_completed', encoded)).toEqual({
      trigger: 'background',
      rowsWritten: 412,
      latencyMs: 1830,
    })
  })

  it('accepts rowsWritten: 0 — an empty cycle still completed', () => {
    // The label should refresh even when the sync found nothing new.
    const encoded = encodeDeviceEventPayload('sync_completed', {
      trigger: 'manual',
      rowsWritten: 0,
      latencyMs: 12,
    })
    expect(decodeDeviceEventPayload('sync_completed', encoded)?.rowsWritten).toBe(0)
  })

  it('round-trips every event type with a representative payload', () => {
    const samples = {
      paired: {},
      unpaired: {},
      connected: {},
      disconnected: {},
      battery_sample: { level: 82 },
      battery_low: { level: 8, threshold: 10 },
      firmware_updated: { fromVersion: '1.0.0', toVersion: '1.1.0' },
      sync_started: { trigger: 'auto' },
      sync_completed: { trigger: 'auto', rowsWritten: 1, latencyMs: 5 },
      sync_failed: { trigger: 'auto', error: 'timeout', retryCount: 2 },
    } as const

    for (const type of DEVICE_EVENT_TYPES) {
      const encoded = encodeDeviceEventPayload(type, samples[type] as never)
      expect(decodeDeviceEventPayload(type, encoded)).toEqual(samples[type])
    }
  })
})

describe('validation on write', () => {
  it('throws rather than writing a row a consumer cannot parse', () => {
    expect(() =>
      encodeDeviceEventPayload('sync_completed', {
        trigger: 'background',
        // @ts-expect-error deliberately wrong type
        rowsWritten: 'lots',
        latencyMs: 10,
      }),
    ).toThrow()
  })

  it('rejects unknown keys — silent drops would hide producer drift', () => {
    expect(() =>
      encodeDeviceEventPayload('battery_sample', {
        level: 50,
        // @ts-expect-error deliberately extra
        pct: 50,
      }),
    ).toThrow()
  })

  it('rejects an out-of-range battery level', () => {
    expect(() => encodeDeviceEventPayload('battery_sample', { level: 101 }))
      .toThrow()
    expect(() => encodeDeviceEventPayload('battery_sample', { level: -1 }))
      .toThrow()
  })

  it('rejects an unknown sync trigger', () => {
    expect(() =>
      // @ts-expect-error deliberately invalid enum member
      encodeDeviceEventPayload('sync_started', { trigger: 'cron' }),
    ).toThrow()
  })
})

describe('decode degrades gracefully on read', () => {
  // One unreadable historical row must not crash a screen.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['malformed JSON', '{not json'],
    ['wrong shape', '{"trigger":"auto"}'],
    ['JSON null', 'null'],
  ])('returns null for %s', (_label, raw) => {
    expect(decodeDeviceEventPayload('sync_completed', raw as string)).toBeNull()
  })
})
