/**
 * T-25 — Event bus integration.
 *
 * The sync layer publishes two families of invalidation events:
 *   `{table}:insert`        — emitted after a successful flush of local rows.
 *   `{table}:sync_complete` — emitted after a successful push to the remote R2
 *                             zone completes with rows written.
 *
 * The `EventBus` is injected by the app (typically `@mongrov/core`'s event bus).
 * Consumers use these events to invalidate caches / re-run subscriptions.
 */

import type { FlushedEvent, SyncEmitter } from './flusher'
import type { PushResult } from './pusher'

/**
 * Minimal event-bus contract. Kept narrow so any host (React Query cache,
 * mitt, EventEmitter, custom fan-out) satisfies it structurally.
 */
export interface EventBus {
  emit: (name: string, payload?: unknown) => void
}

export interface FlushInsertPayload {
  table: string
  rowsFlushed: number
  reason: string
}

export interface SyncCompletePayload {
  table: string
  rowsPushed: number
}

/**
 * Adapts an `EventBus` into a `SyncEmitter` (as consumed by `BatchFlusher.emit`).
 * Only successful flushes produce an `${table}:insert` event; failures pass
 * through silently at the bus layer (the flusher already emits `flush-failed`
 * to any co-subscribed emitter).
 */
export function bindFlushEvents(bus: EventBus): SyncEmitter {
  return (event) => {
    if (event.type === 'flushed') {
      const payload: FlushInsertPayload = {
        table: event.payload.table,
        rowsFlushed: event.payload.rowsFlushed,
        reason: event.payload.reason,
      }
      bus.emit(`${event.payload.table}:insert`, payload)
    }
  }
}

export type PushEmitter = (result: PushResult) => void

/**
 * Adapts an `EventBus` into a `PushEmitter`. Only successful pushes with at
 * least one row published produce `${table}:sync_complete`; ok-but-empty pushes
 * are silent (no downstream invalidation is needed).
 */
export function bindPushEvents(bus: EventBus): PushEmitter {
  return (result) => {
    if (result.ok && result.rowsPushed > 0) {
      const payload: SyncCompletePayload = {
        table: result.table,
        rowsPushed: result.rowsPushed,
      }
      bus.emit(`${result.table}:sync_complete`, payload)
    }
  }
}

/**
 * Re-export the FlushedEvent shape for callers that need to type-narrow their
 * bus payloads.
 */
export type { FlushedEvent }
