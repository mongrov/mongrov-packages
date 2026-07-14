/**
 * T-26 — `createSyncManager()` factory.
 *
 * Zod-validates config at construction time (fail-fast), then assembles the
 * full sync stack:
 *
 *   OverflowStore ← storage KV
 *   SensorBuffer  ← OverflowStore + policy + byte budget
 *   BatchFlusher  ← engine + buffer + columnOrder + optional event bus
 *   FlushTriggers ← buffer + flusher + row/age thresholds
 *   WatermarkStore← storage KV
 *   R2Pusher      ← engine + WatermarkStore + optional refreshToken + event bus
 *   R2Fetcher     ← engine + WatermarkStore + tables + prefetchPolicy
 *   SyncScheduler ← wires flush + push + fetch into a background cycle
 *
 * The returned `SyncManager` exposes a compact `SensorSink` + scheduler
 * controls; hooks in `hooks.ts` subscribe to state transitions.
 */

import { z } from 'zod'

import type { HybridDuckDB } from '../core/engine'
import type { AnalyticsEngine, AttachContext, KVStore } from '../core/types'
import { SensorBuffer } from './buffer'
import { bindFlushEvents, bindPushEvents } from './events'
import type { EventBus } from './events'
import { R2Fetcher } from './fetcher'
import type { PrefetchPolicy } from './fetcher'
import { BatchFlusher } from './flusher'
import type { SyncEmitter } from './flusher'
import { mapFirmwareExport } from './mapper/firmware'
import type { FirmwareExport, MapperContext } from './mapper/types'
import { OverflowStore } from './overflow'
import { R2Pusher } from './pusher'
import {
  type BackgroundTaskPort,
  type ConstraintPort,
  type SchedulerLogger,
  type SchedulerState,
  SyncScheduler,
} from './scheduler'
import type { SensorSink, SyncManager, SyncManagerState, SyncProgress } from './manager'
import { FlushTriggers } from './triggers'
import type { FlushResult, OverflowPolicy, SensorBatch } from './types'
import { WatermarkStore } from './watermark'

import type { TableName } from '../core/schemas'
import type { RulesEngine } from '../rules/types'

const overflowPolicyEnum = z.enum(['drop-oldest', 'drop-newest', 'block'])

const prefetchPolicySchema: z.ZodType<PrefetchPolicy> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all-family-on-attach'), windowDays: z.number().int().positive() }),
  z.object({
    kind: z.literal('recent-active-only'),
    activeDays: z.number().int().positive(),
    windowDays: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('lazy') }),
])

const configSchema = z.object({
  tables: z.array(z.string().min(1)).min(1),
  columnOrder: z.record(z.string(), z.array(z.string()).readonly()),
  prefetchPolicy: prefetchPolicySchema,
  flush: z.object({
    maxRows: z.number().int().positive().optional(),
    maxAgeMs: z.number().int().positive().optional(),
    concurrency: z.number().int().positive().optional(),
  }).optional(),
  overflow: z.object({
    maxBufferBytes: z.number().int().positive().optional(),
    policy: overflowPolicyEnum.optional(),
  }).optional(),
  scheduler: z.object({
    requiresCharging: z.boolean().optional(),
    requiresWifi: z.boolean().optional(),
    taskName: z.string().optional(),
  }).optional(),
})

export interface CreateSyncManagerConfig {
  analytics: AnalyticsEngine
  storage: KVStore
  ctx: AttachContext
  tables: readonly string[]
  columnOrder: Record<string, readonly string[]>
  prefetchPolicy: PrefetchPolicy
  eventBus?: EventBus
  refreshToken?: () => Promise<void>
  backgroundTask?: BackgroundTaskPort
  constraints?: ConstraintPort
  flush?: {
    maxRows?: number
    maxAgeMs?: number
    concurrency?: number
  }
  overflow?: {
    maxBufferBytes?: number
    policy?: OverflowPolicy
  }
  scheduler?: {
    requiresCharging?: boolean
    requiresWifi?: boolean
    taskName?: string
  }
  /**
   * Optional rules engine wired into the flush pipeline. After a successful
   * flush the manager calls `rulesEngine.evaluateOnBatch({ affectedUserIds,
   * affectedTables: [table] })`. Fire-and-forget: the evaluator swallows its
   * own errors, so we never block a sync cycle on rules.
   */
  rulesEngine?: RulesEngine
  logger?: SchedulerLogger
}

/**
 * Assemble a fully wired `SyncManager`. Throws `z.ZodError` if the config is
 * malformed (e.g., missing columnOrder entries or negative row limits).
 */
export function createSyncManager(config: CreateSyncManagerConfig): SyncManager {
  configSchema.parse({
    tables: config.tables,
    columnOrder: config.columnOrder,
    prefetchPolicy: config.prefetchPolicy,
    flush: config.flush,
    overflow: config.overflow,
    scheduler: config.scheduler,
  })

  const overflow = new OverflowStore(config.storage)
  const buffer = new SensorBuffer({
    overflow,
    maxBufferBytes: config.overflow?.maxBufferBytes,
    policy: config.overflow?.policy,
  })

  const progress: SyncProgress = { pendingByTable: {} }
  const busFlushEmit = config.eventBus ? bindFlushEvents(config.eventBus) : undefined

  // Compose the flusher emitter with local progress tracking so hooks + the
  // event bus both see every event. When a rules engine is provided, `flushed`
  // events also drive `evaluateOnBatch` — fire-and-forget so a slow evaluator
  // never stalls sync.
  const rulesEngine = config.rulesEngine
  const rulesLogger = config.logger
  const flushEmitter: SyncEmitter = (event) => {
    if (event.type === 'flushed') {
      progress.pendingByTable[event.payload.table] = 0
      progress.lastFlushAt = Date.now()
      if (rulesEngine && event.payload.affectedUserIds.length > 0) {
        rulesEngine.evaluateOnBatch({
          affectedUserIds: event.payload.affectedUserIds,
          affectedTables: [event.payload.table as TableName],
        }).catch((err: unknown) => {
          rulesLogger?.warn('sync.factory: rulesEngine.evaluateOnBatch threw', {
            table: event.payload.table,
            err: err instanceof Error ? err.message : String(err),
          })
        })
      }
    }
    busFlushEmit?.(event)
  }

  const engineAsHybrid = config.analytics as unknown as HybridDuckDB

  const flusher = new BatchFlusher({
    engine: engineAsHybrid,
    buffer,
    columnOrder: config.columnOrder,
    concurrency: config.flush?.concurrency,
    emit: flushEmitter,
  })

  const triggers = new FlushTriggers({
    buffer,
    flusher,
    maxRows: config.flush?.maxRows,
    maxAgeMs: config.flush?.maxAgeMs,
  })

  const watermark = new WatermarkStore({ kv: config.storage })

  const busPushEmit = config.eventBus ? bindPushEvents(config.eventBus) : undefined
  const pusher = new R2Pusher({
    engine: engineAsHybrid,
    watermark,
    refreshToken: config.refreshToken,
    emit: (result) => {
      if (result.ok && result.rowsPushed > 0) {
        progress.lastSyncCompleteAt = Date.now()
      }
      busPushEmit?.(result)
    },
  })

  const fetcher = new R2Fetcher({
    engine: engineAsHybrid,
    watermark,
    tables: [...config.tables],
  })

  const scheduler = new SyncScheduler({
    backgroundTask: config.backgroundTask ?? noopBackgroundTask(),
    constraints: config.constraints ?? alwaysAllowedConstraints(),
    coordinator: {
      flushAll: async () => {
        await Promise.all(config.tables.map(t => flusher.flush(t, 'scheduled')))
      },
      pushAll: async (tables, ctx) => pusher.pushAll(tables, ctx),
      fetchIncremental: async ctx => fetcher.fetchIncremental(ctx),
      // Scheduled rules pass runs after the cycle's flush/push/fetch. Fire-
      // and-forget — a throw here would surface as a cycle error, but the
      // catch keeps the scheduler idle.
      onCycleComplete: rulesEngine
        ? async () => {
            try {
              await rulesEngine.evaluateScheduled()
            }
            catch (err) {
              rulesLogger?.warn('sync.factory: rulesEngine.evaluateScheduled threw', {
                err: err instanceof Error ? err.message : String(err),
              })
            }
          }
        : undefined,
    },
    tables: [...config.tables],
    ctx: config.ctx,
    taskName: config.scheduler?.taskName,
    constraintPolicy: {
      requireCharging: config.scheduler?.requiresCharging,
      requireWifi: config.scheduler?.requiresWifi,
    },
    logger: config.logger,
  })

  const state: SyncManagerState = {
    scheduler: 'idle',
  }
  const subscribers = new Set<(s: SyncManagerState) => void>()
  const notify = () => {
    for (const fn of subscribers) fn(state)
  }
  scheduler.subscribe((next: SchedulerState) => {
    state.scheduler = next
    notify()
  })

  const sink = createSensorSink({ buffer, flusher, triggers, tables: config.tables })

  return {
    analytics: config.analytics,
    sink,
    flusher,
    pusher,
    fetcher,
    scheduler,
    state: () => ({ ...state }),
    progress: () => ({
      pendingByTable: { ...progress.pendingByTable },
      lastFlushAt: progress.lastFlushAt,
      lastSyncCompleteAt: progress.lastSyncCompleteAt,
    }),
    subscribe: (fn) => {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    start: async () => {
      await scheduler.start()
    },
    stop: async () => {
      await scheduler.stop()
    },
    triggerNow: () => scheduler.triggerNow(),
    prefetch: (ctx) => fetcher.prefetchOnAttach(ctx, config.prefetchPolicy),
  }
}

// ---------- helpers ----------

interface CreateSinkDeps {
  buffer: SensorBuffer
  flusher: BatchFlusher
  triggers: FlushTriggers
  tables: readonly string[]
}

function createSensorSink({ buffer, flusher, triggers, tables }: CreateSinkDeps): SensorSink {
  return {
    push: async (batch: SensorBatch) => {
      await buffer.push(batch)
      triggers.noteEnqueue(batch.table, Date.now())
    },
    pushFirmware: async (fw: FirmwareExport, ctx: MapperContext) => {
      const mapped = mapFirmwareExport(fw, ctx)
      const asRows = <T>(rows: readonly T[]): Record<string, unknown>[] =>
        rows as unknown as Record<string, unknown>[]
      const mappedTables: Array<[string, Record<string, unknown>[]]> = [
        ['hrv', asRows(mapped.hrv)],
        ['heart_rate', asRows(mapped.heart_rate)],
        ['spo2', asRows(mapped.spo2)],
        ['temperature', asRows(mapped.temperature)],
        ['activity', asRows(mapped.activity)],
        ['activity_bucket', asRows(mapped.activity_bucket)],
        ['sleep_session', asRows(mapped.sleep_session)],
        ['sleep_stage', asRows(mapped.sleep_stage)],
        ['sleep_raw', asRows(mapped.sleep_raw)],
        ['device_event', asRows(mapped.device_event)],
        ['device_config', asRows(mapped.device_config)],
      ]
      for (const [table, rows] of mappedTables) {
        if (!rows || rows.length === 0) continue
        await buffer.push({
          table,
          brand: ctx.brand,
          familyId: ctx.familyId,
          userId: ctx.userId,
          deviceId: ctx.deviceId,
          rows,
        })
        triggers.noteEnqueue(table, Date.now())
      }
    },
    flush: async () => {
      const results: FlushResult[] = []
      for (const table of tables) {
        results.push(await flusher.flush(table, 'manual'))
        triggers.noteDrain(table)
      }
      return results
    },
    pendingRowCount: async (table?: string) => {
      const s = await buffer.size(table)
      return s.inMemory + s.overflow
    },
    clear: async () => {
      await buffer.clear()
      for (const t of tables) triggers.noteDrain(t)
    },
  }
}

function noopBackgroundTask(): BackgroundTaskPort {
  const handlers = new Map<string, () => Promise<void>>()
  return {
    register: async (name, handler) => { handlers.set(name, handler) },
    unregister: async (name) => { handlers.delete(name) },
    isRegistered: async name => handlers.has(name),
  }
}

function alwaysAllowedConstraints(): ConstraintPort {
  return {
    isCharging: async () => true,
    isOnWifi: async () => true,
  }
}
