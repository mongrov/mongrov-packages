/**
 * Typed sync-lifecycle emitter (Sprint 5 T-39).
 *
 * Wraps a `DeviceEventSink` so the sync path emits a well-formed
 * `sync_started` / `sync_completed` / `sync_failed` triple without every call
 * site rebuilding payloads or remembering to stamp latency.
 *
 * ## Scope note
 *
 * T-39 asks `@mongrov/device` to emit these events from its sync
 * lifecycle. That lifecycle — the sync machine behind `createDeviceClient()`
 * — is D5 work and does not exist in this package yet: only the connection
 * and registry machines ship today. So this module provides the *emitter*,
 * fully typed and tested, and D5 wires it into the machine's transitions.
 * Building a sync machine here purely to have somewhere to call it from
 * would be inventing D5's design from inside a Sprint 5 task.
 *
 * The emitter is deliberately usable stand-alone: an app driving sync
 * through a vendor SDK today can call `beginSync()` directly and get the
 * same events, which is what makes the "Updated N min ago" label work
 * before D5 lands.
 */

import type { DeviceEventSink } from './ports'
import type { SyncTriggerValue } from '@mongrov/types/device-events'

/** Injectable clock so latency is testable without timers. */
export type Clock = () => number

export interface SyncEventEmitterConfig {
  sink: DeviceEventSink
  /** Defaults to `Date.now`. */
  now?: Clock
}

/** Handle for one in-flight sync run. */
export interface SyncRun {
  /**
   * Emit `sync_completed` with measured latency.
   *
   * `rowsWritten: 0` is legitimate — a cycle that found nothing new still
   * completed, and the freshness label should still advance.
   */
  complete(rowsWritten: number): void
  /** Emit `sync_failed`. `retryCount` is this run's attempt index. */
  fail(error: unknown, retryCount?: number): void
  /** True once `complete` or `fail` has been called. */
  readonly settled: boolean
}

export interface SyncEventEmitter {
  /** Emit `sync_started` and return a handle for the terminal event. */
  beginSync(deviceId: string, trigger: SyncTriggerValue): SyncRun
}

/** Normalize an unknown throwable to a short, loggable string. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? 'unknown error'
  }
  catch {
    return 'unknown error'
  }
}

export function createSyncEventEmitter(
  config: SyncEventEmitterConfig,
): SyncEventEmitter {
  const now = config.now ?? (() => Date.now())

  return {
    beginSync(deviceId, trigger) {
      const startedAt = now()
      let settled = false

      config.sink.emit('sync_started', deviceId, { trigger })

      return {
        get settled() {
          return settled
        },
        complete(rowsWritten) {
          // Guard against a double-settle emitting two terminal events for
          // one run, which would double-count in any downstream tally.
          if (settled) return
          settled = true
          config.sink.emit('sync_completed', deviceId, {
            trigger,
            rowsWritten,
            latencyMs: Math.max(0, now() - startedAt),
          })
        },
        fail(error, retryCount = 0) {
          if (settled) return
          settled = true
          config.sink.emit('sync_failed', deviceId, {
            trigger,
            error: describeError(error),
            retryCount,
          })
        },
      }
    },
  }
}
