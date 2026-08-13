/**
 * Test-only fakes for the four device ports.
 *
 * ReadingSink   → captures every write in an in-memory array
 * ConfigStore   → in-memory Map keyed on `${deviceId}::${metric}`
 * DeviceLogger  → captures every diagnostic event
 * LifecyclePort → in-process pub/sub with `setState()` for driving transitions
 */

import type { DeviceDiagnosticEvent, DeviceReading } from '@mongrov/types'

import type {
  ConfigStore,
  DeviceLogger,
  LifecyclePort,
  LifecycleState,
  ReadingSink,
} from '../ports'

// ─── ReadingSink ───────────────────────────────────────────────────────────

export interface FakeReadingSink {
  sink: ReadingSink
  /** Every reading passed to `write()`, in call order. */
  writes: DeviceReading[]
  /** Clear the recorded writes. */
  reset: () => void
}

export function createFakeReadingSink(): FakeReadingSink {
  const writes: DeviceReading[] = []
  const sink: ReadingSink = {
    async write(reading) {
      writes.push(reading)
    },
  }
  return {
    sink,
    writes,
    reset() {
      writes.length = 0
    },
  }
}

// ─── ConfigStore ───────────────────────────────────────────────────────────

export interface FakeConfigStore {
  store: ConfigStore
  /** Read the raw in-memory map (for assertions). */
  snapshot: () => Record<string, number>
  /** Wipe the map. */
  reset: () => void
}

export function createFakeConfigStore(): FakeConfigStore {
  const cursors = new Map<string, number>()
  const key = (deviceId: string, metric: string): string =>
    `${deviceId}::${metric}`

  const store: ConfigStore = {
    async getCursor(deviceId, metric) {
      return cursors.get(key(deviceId, metric))
    },
    async setCursor(deviceId, metric, cursor) {
      cursors.set(key(deviceId, metric), cursor)
    },
  }
  return {
    store,
    snapshot() {
      return Object.fromEntries(cursors.entries())
    },
    reset() {
      cursors.clear()
    },
  }
}

// ─── DeviceLogger ──────────────────────────────────────────────────────────

export interface FakeLogger {
  logger: DeviceLogger
  /** Every event passed to `log()`, in call order. */
  events: DeviceDiagnosticEvent[]
  reset: () => void
}

export function createFakeLogger(): FakeLogger {
  const events: DeviceDiagnosticEvent[] = []
  const logger: DeviceLogger = {
    log(event) {
      events.push(event)
    },
  }
  return {
    logger,
    events,
    reset() {
      events.length = 0
    },
  }
}

// ─── LifecyclePort ─────────────────────────────────────────────────────────

export interface FakeLifecycle {
  lifecycle: LifecyclePort
  /** Drive a state change through every subscriber. */
  setState: (next: LifecycleState) => void
  /** Snapshot of active subscriber count (for cleanup assertions). */
  subscriberCount: () => number
}

export function createFakeLifecycle(): FakeLifecycle {
  const listeners = new Set<(state: LifecycleState) => void>()

  const lifecycle: LifecyclePort = {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }

  return {
    lifecycle,
    setState(next) {
      for (const listener of listeners) {
        listener(next)
      }
    },
    subscriberCount() {
      return listeners.size
    },
  }
}
