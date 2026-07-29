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
import type {
  DeviceConfigRow,
  FirmwareExport,
  MapperContext,
  RingConfigTranslator,
} from './mapper/types'
import { OverflowStore } from './overflow'
import { PendingClosesStore } from './pending_closes'
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
  hasRingConfigTranslator: z.boolean(),
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
}).refine(
  cfg => !cfg.tables.includes('device_config') || cfg.hasRingConfigTranslator,
  {
    message: 'ringConfigTranslator is required when `tables` includes \'device_config\'',
    path: ['ringConfigTranslator'],
  },
)

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
  /**
   * Consumer-provided translation between firmware ring-config semantics
   * and the schema-shaped `device_config` row. **Required** whenever
   * `tables` includes `'device_config'` — enforced at construction by a
   * Zod refinement. See `mapper/types.ts` for the contract.
   */
  ringConfigTranslator?: RingConfigTranslator
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
    hasRingConfigTranslator: config.ringConfigTranslator !== undefined,
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

  // Local-mode gate: in `analytics.mode === 'local'` there's no remote R2
  // to push/fetch against. Instead of removing the pusher/fetcher entirely
  // (they're still returned on the SyncManager surface for consumers that
  // inspect them), we short-circuit the scheduler's coordinator hooks so
  // no push/fetch SQL actually runs. Rules still fire on-batch via the
  // flusher; scheduled rules also fire via `onCycleComplete`.
  const isLocal = config.analytics.mode === 'local'

  const pendingClosesStore = new PendingClosesStore(config.storage)

  const scheduler = new SyncScheduler({
    backgroundTask: config.backgroundTask ?? noopBackgroundTask(),
    constraints: config.constraints ?? alwaysAllowedConstraints(),
    coordinator: {
      flushAll: async () => {
        await Promise.all(config.tables.map(t => flusher.flush(t, 'scheduled')))
      },
      pushAll: isLocal
        ? async () => []
        : async (tables, ctx) => pusher.pushAll(tables, ctx),
      pushClosesForDeviceConfig: (isLocal || !config.tables.includes('device_config'))
        ? undefined
        : async (ctx) => {
            const pending = await pendingClosesStore.drain(ctx)
            if (pending.length === 0) return
            try {
              const result = await pusher.pushCloses(pending, ctx)
              if (!result.ok) {
                await pendingClosesStore.requeue(ctx, pending)
                rulesLogger?.warn('sync.factory: pushCloses failed; requeued', {
                  count: pending.length,
                  code: result.error?.code,
                })
              }
            }
            catch (err) {
              await pendingClosesStore.requeue(ctx, pending)
              rulesLogger?.warn('sync.factory: pushCloses threw; requeued', {
                count: pending.length,
                err: err instanceof Error ? err.message : String(err),
              })
            }
          },
      fetchIncremental: isLocal
        ? async () => []
        : async ctx => fetcher.fetchIncremental(ctx),
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

  const sink = createSensorSink({
    buffer,
    flusher,
    triggers,
    tables: config.tables,
    engine: engineAsHybrid,
    attachCtx: config.ctx,
    translator: config.ringConfigTranslator,
    pendingClosesStore,
  })

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
    prefetch: isLocal
      ? async () => []
      : ctx => fetcher.prefetchOnAttach(ctx, config.prefetchPolicy),
  }
}

// ---------- helpers ----------

interface CreateSinkDeps {
  buffer: SensorBuffer
  flusher: BatchFlusher
  triggers: FlushTriggers
  tables: readonly string[]
  engine: HybridDuckDB
  attachCtx: AttachContext
  translator: RingConfigTranslator | undefined
  pendingClosesStore: PendingClosesStore
}

/**
 * Pre-fetch the currently-open `device_config` rows for the given device
 * so `mapRingConfig` can decide which metrics need SCD-2 closes.
 *
 * Value shape (`DeviceConfigRow`) is not consulted by the mapper — only
 * `.has(dataType)` — but hydrating the row keeps the map future-friendly
 * for logging / diagnostics without a second query.
 */
async function fetchActivePriorConfigs(
  engine: HybridDuckDB,
  ctx: MapperContext,
): Promise<Map<number, DeviceConfigRow>> {
  // Fully-qualified `memory.main.device_config` so this resolves against the
  // local in-memory catalog regardless of the active `USE <iceberg>.default`
  // that `attach()` issues. A 2-part `main.device_config` would resolve
  // against the current (Iceberg) catalog post-attach and miss.
  const rows = await engine.execute<Record<string, unknown>>(
    `SELECT device_id, brand, family_id, user_id, data_type, interval_minutes, start_time, end_time, weeks, valid_from, valid_to
       FROM memory.main.device_config
      WHERE device_id = $device_id
        AND family_id = $family_id
        AND user_id = $user_id
        AND valid_to IS NULL`,
    {
      device_id: ctx.deviceId,
      family_id: ctx.familyId,
      user_id: ctx.userId,
    },
  )
  const map = new Map<number, DeviceConfigRow>()
  for (const r of rows) {
    const dataType = Number(r.data_type)
    map.set(dataType, {
      ts: new Date(String(r.valid_from ?? '')),
      brand: String(r.brand ?? ''),
      family_id: String(r.family_id ?? ''),
      user_id: String(r.user_id ?? ''),
      device_id: String(r.device_id ?? ''),
      data_type: dataType,
      interval_minutes: Number(r.interval_minutes),
      start_time: r.start_time == null ? null : String(r.start_time),
      end_time: r.end_time == null ? null : String(r.end_time),
      weeks: r.weeks == null ? null : Number(r.weeks),
      valid_from: new Date(String(r.valid_from ?? '')),
      valid_to: r.valid_to == null ? null : new Date(String(r.valid_to)),
    })
  }
  return map
}

function createSensorSink(deps: CreateSinkDeps): SensorSink {
  const { buffer, flusher, triggers, tables, engine, attachCtx, translator, pendingClosesStore } = deps
  const handlesConfig = tables.includes('device_config') && translator !== undefined

  return {
    push: async (batch: SensorBatch) => {
      await buffer.push(batch)
      triggers.noteEnqueue(batch.table, Date.now())
    },
    pushFirmware: async (fw: FirmwareExport, ctx: MapperContext) => {
      // 1) Pre-fetch open configs for this device so the mapper can decide
      //    which metrics need SCD-2 closes. Skipped when we're not
      //    subscribed to device_config or no translator is wired.
      const activePriorConfigs = handlesConfig
        ? await fetchActivePriorConfigs(engine, ctx)
        : new Map<number, DeviceConfigRow>()

      // 2) Map firmware → mapped batch. The mapper requires a translator
      //    only when firmware has ring windows; the wrapper in `firmware.ts`
      //    enforces that.
      const mapped = mapFirmwareExport(fw, ctx, {
        activePriorConfigs,
        translator,
      })

      // 3) SCD-2 close handling. Enqueue-before-UPDATE keeps the local
      //    UPDATE + remote UPDATE replay-safe under crash: both are
      //    idempotent via the `valid_to IS NULL` guard.
      if (handlesConfig && mapped.device_config_closes.length > 0) {
        await pendingClosesStore.enqueue(attachCtx, mapped.device_config_closes)
        for (const close of mapped.device_config_closes) {
          // Fully-qualified `memory.main.device_config` — same reason as
          // `fetchActivePriorConfigs` above: sink runs after `attach()` has
          // called `USE <iceberg>.default`, so 2-part names miss.
          await engine.execute(
            `UPDATE memory.main.device_config
                SET valid_to = $valid_to
              WHERE device_id = $device_id
                AND data_type = $data_type
                AND valid_to IS NULL`,
            {
              valid_to: close.valid_to.toISOString(),
              device_id: close.device_id,
              data_type: close.data_type,
            },
          )
        }
      }

      // 4) Buffer the new inserts across every mapped table.
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
