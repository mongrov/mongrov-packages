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

import type { EventBus as AnalyticsEventBus } from '../core/types'
import type { FlushedEvent, SyncEmitter } from './flusher'
import type { PushResult } from './pusher'

/**
 * The emit-only half of the package's `EventBus` contract.
 *
 * Derived from `core/types.ts` rather than redeclared: the sync layer only
 * ever publishes, so requiring `subscribe` / `subscribePattern` here would
 * force every host (React Query cache, mitt, EventEmitter, custom fan-out)
 * to implement surface it never uses. Deriving keeps the two in step — a
 * change to the core `emit` signature surfaces here instead of silently
 * producing two incompatible buses in one package.
 */
export type EventBus = Pick<AnalyticsEventBus, 'emit'>

export interface FlushInsertPayload {
  table: string
  rowsFlushed: number
  reason: string
}

export interface SyncCompletePayload {
  table: string
  rowsPushed: number
}

/** Payload of the `batch:complete` bus event (Sprint 5 T-12). */
export interface BatchCompletePayload {
  batchId: string
  affectedTables: string[]
  affectedUserIds: string[]
  brand?: string
  familyId?: string
  rowCounts: Record<string, number>
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
      return
    }
    if (event.type === 'batch-complete') {
      // Both event families are emitted, and they serve different
      // consumers: `{table}:insert` drives cache invalidation, which wants
      // to refresh as early as possible, while `batch:complete` drives rule
      // evaluation, which must not run until every table has landed
      // (Sprint 5 item (a)).
      const payload: BatchCompletePayload = {
        batchId: event.payload.batchId,
        affectedTables: event.payload.affectedTables,
        affectedUserIds: event.payload.affectedUserIds,
        brand: event.payload.brand,
        familyId: event.payload.familyId,
        rowCounts: event.payload.rowCounts,
      }
      bus.emit('batch:complete', payload)
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
