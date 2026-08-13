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

import type { HybridDuckDB } from '../core/engine'

import type { TableName } from '../core/schemas'
import type { AnalyticsEngine, AttachContext, KVStore } from '../core/types'
import type { RulesEngine } from '../rules/types'
import type { EventBus } from './events'
import type { PrefetchPolicy } from './fetcher'
import type { SyncEmitter } from './flusher'
import type { SensorSink, SyncManager, SyncManagerState, SyncProgress } from './manager'
import type {
  DeviceConfigRow,
  FirmwareExport,
  MapperContext,
  RingConfigTranslator,
} from './mapper/types'
import type { BackgroundTaskPort, ConstraintPort, SchedulerLogger, SchedulerState } from './scheduler'
import type { FlushResult, OverflowPolicy, SensorBatch } from './types'
import { z } from 'zod'
import { createBaselineComputer } from './baseline-compute'
import { SensorBuffer } from './buffer'
import { bindFlushEvents, bindPushEvents } from './events'
import { R2Fetcher } from './fetcher'
import { BatchFlusher } from './flusher'
import { mapFirmwareExport } from './mapper/firmware'
import { OverflowStore } from './overflow'
import { PendingClosesStore } from './pending_closes'
import { R2Pusher } from './pusher'
import {

  SyncScheduler,
} from './scheduler'

import { FlushTriggers } from './triggers'
import { WatermarkStore } from './watermark'

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
   * Optional rules engine wired into the flush pipeline. Evaluation is
   * driven by `batch:complete` (see `strictBatchOrdering`). Fire-and-forget:
   * the evaluator swallows its own errors, so we never block a sync cycle
   * on rules.
   */
  rulesEngine?: RulesEngine
  /**
   * When true (default), rules evaluate once per batch on `batch:complete`
   * rather than per table on each `{table}:insert` (Sprint 5 item (a)).
   *
   * This is the fix for a real race: a `context: 'asleep'` rule JOINs
   * `v_sleep_session`, and firing it the moment `spo2` flushes lets it
   * evaluate against a night whose sleep rows are still buffered. Set
   * false only for a consumer that wants lower evaluation latency and
   * ships no context-JOIN or consecutive rules.
   */
  strictBatchOrdering?: boolean
  /**
   * Resolve a user's IANA timezone for day-first baseline bucketing
   * (Sprint 5 §7). `User.timezone` lives in auth/RxDB, so it has to be
   * injected rather than read here. Falls back to the device zone when
   * omitted or when it resolves undefined — wrong-but-close beats
   * refusing to compute a baseline at all.
   */
  userTimezoneProvider?: (userId: string) => Promise<string | undefined>
  /** Disable the per-cycle baseline recompute (Sprint 5 T-15). */
  computeBaselines?: boolean
  logger?: SchedulerLogger
  /**
   * @deprecated Ignored since Sprint 5 T-09/T-10. The mapper reads the
   * vendor `AutomaticMonitoring_J2301A` struct directly and owns the
   * `dataType` → metric translation, so no consumer-supplied bridge is
   * needed. Accepted for one release so existing call sites keep
   * compiling.
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
  // Sprint 5 item (a): rules evaluate on `batch-complete`, never per-table.
  // `strictBatchOrdering` (default true) is the escape hatch — setting it
  // false restores the 0.1.0 per-table trigger for a consumer that needs
  // lower latency and has no context-JOIN rules to race against.
  const strictBatchOrdering = config.strictBatchOrdering ?? true

  const evaluateRules = (
    affectedTables: TableName[],
    affectedUserIds: string[],
    label: string,
  ): void => {
    if (!rulesEngine || affectedUserIds.length === 0 || affectedTables.length === 0) {
      return
    }
    // Fire-and-forget: a slow or throwing evaluator must never stall sync
    // (principle 35).
    rulesEngine.evaluateOnBatch({ affectedUserIds, affectedTables })
      .catch((err: unknown) => {
        rulesLogger?.warn('sync.factory: rulesEngine.evaluateOnBatch threw', {
          trigger: label,
          err: err instanceof Error ? err.message : String(err),
        })
      })
  }

  const flushEmitter: SyncEmitter = (event) => {
    if (event.type === 'flushed') {
      progress.pendingByTable[event.payload.table] = 0
      progress.lastFlushAt = Date.now()
      if (!strictBatchOrdering) {
        evaluateRules(
          [event.payload.table as TableName],
          event.payload.affectedUserIds,
          `table:${event.payload.table}`,
        )
      }
    }
    if (event.type === 'batch-complete' && strictBatchOrdering) {
      // Every table in the batch has landed, so a `context: 'asleep'` rule
      // can now JOIN v_sleep_session and see the whole night.
      evaluateRules(
        event.payload.affectedTables as TableName[],
        event.payload.affectedUserIds,
        `batch:${event.payload.batchId}`,
      )
    }
    busFlushEmit?.(event)
  }

  /**
   * Device timezone, used when the app supplies no `userTimezoneProvider`
   * or the provider has no profile for a user. `Intl` is present on every
   * RN runtime we target (Hermes with intl enabled); the `catch` covers
   * bare JS hosts in CI.
   */
  function deviceTimezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    }
    catch {
      return 'UTC'
    }
  }

  async function resolveTimezone(userId: string): Promise<string> {
    if (!config.userTimezoneProvider)
      return deviceTimezone()
    try {
      return (await config.userTimezoneProvider(userId)) ?? deviceTimezone()
    }
    catch {
      // A profile lookup failure must not skip the baseline entirely —
      // a baseline in the device zone is far better than none.
      return deviceTimezone()
    }
  }

  const baselineComputer = createBaselineComputer({
    analytics: config.analytics,
    eventBus: config.eventBus as never,
    logger: config.logger,
  })

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
        // One batch per scheduler cycle: rules see the whole cycle's write
        // as a single unit rather than one wake-up per table.
        const batchId = flusher.beginBatch('scheduled')
        try {
          await Promise.all(
            config.tables.map(t => flusher.flush(t, 'scheduled', batchId)),
          )
        }
        finally {
          // `finally` so a partial failure still closes the batch — the
          // tables that DID land are real writes and their consumers
          // should be woken. Leaving it open would leak the record and
          // silently suppress the next cycle's evaluation.
          flusher.endBatch(batchId)
        }
      },
      pushAll: isLocal
        ? async () => []
        : async (tables, ctx) => pusher.pushAll(tables, ctx),
      pushClosesForDeviceConfig: (isLocal || !config.tables.includes('device_config'))
        ? undefined
        : async (ctx) => {
          const pending = await pendingClosesStore.drain(ctx)
          if (pending.length === 0)
            return
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
      computeBaselines: config.computeBaselines === false
        ? undefined
        : async () => {
          // Fan out over the family so every member's baselines refresh
          // on the device that synced — not just the signed-in user's.
          // Empty roster (org scope, local mode, unattached) falls back
          // to the attach ctx's own user.
          let members: string[] = []
          try {
            members = await config.analytics.getFamilyMembers()
          }
          catch {
            members = []
          }
          const userIds = members.length > 0 ? members : [config.ctx.userId]
          for (const userId of userIds) {
            const tz = await resolveTimezone(userId)
            await baselineComputer.computeAll({
              brand: config.ctx.brand,
              familyId: config.ctx.tenantId,
              userId,
              userTimezone: tz,
            })
          }
        },
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
/**
 * Open (`valid_to IS NULL`) device_config rows for one device.
 *
 * Fully-qualified `memory.main.device_config` so this resolves against the
 * local catalog regardless of the active `USE <iceberg>.default` that
 * `attach()` issues — a 2-part `main.device_config` would resolve against
 * the current (Iceberg) catalog post-attach and miss.
 *
 * Exported so a test can execute it against the real DDL. It is
 * hand-written SQL naming columns explicitly, which means a schema change
 * can silently desync it: the 0.8.0 `data_type` -> `metric` rename did
 * exactly that, and every unit test mocked the response so nothing caught
 * it. `__tests__/prior-configs-sql.integration.test.ts` now runs it against
 * a real table built from LOCAL_SCHEMAS.
 */
export const ACTIVE_PRIOR_CONFIGS_SQL
  = `SELECT device_id, brand, family_id, user_id, metric, interval_minutes, `
    + `start_time, end_time, weeks, valid_from, valid_to\n`
    + `       FROM memory.main.device_config\n`
    + `      WHERE device_id = $device_id\n`
    + `        AND family_id = $family_id\n`
    + `        AND user_id = $user_id\n`
    + `        AND valid_to IS NULL`

async function fetchActivePriorConfigs(
  engine: HybridDuckDB,
  ctx: MapperContext,
): Promise<Map<string, DeviceConfigRow>> {
  // See ACTIVE_PRIOR_CONFIGS_SQL.
  const rows = await engine.execute<Record<string, unknown>>(
    ACTIVE_PRIOR_CONFIGS_SQL,
    {
      device_id: ctx.deviceId,
      family_id: ctx.familyId,
      user_id: ctx.userId,
    },
  )
  const map = new Map<string, DeviceConfigRow>()
  for (const r of rows) {
    const metric = String(r.metric ?? '')
    map.set(metric, {
      brand: String(r.brand ?? ''),
      family_id: String(r.family_id ?? ''),
      user_id: String(r.user_id ?? ''),
      device_id: String(r.device_id ?? ''),
      metric,
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
  const { buffer, flusher, triggers, tables, engine, attachCtx, pendingClosesStore } = deps
  // Gated on subscription alone now — the mapper owns the translation, so
  // there is no consumer wiring left that could be missing.
  const handlesConfig = tables.includes('device_config')

  return {
    push: async (batch: SensorBatch) => {
      await buffer.push(batch)
      triggers.noteEnqueue(batch.table, Date.now())
    },
    pushFirmware: async (fw: FirmwareExport, ctx: MapperContext) => {
      // 1) Pre-fetch open configs for this device so the mapper can decide
      //    which metrics need SCD-2 closes. Skipped when we're not
      //    subscribed to device_config.
      const activePriorConfigs = handlesConfig
        ? await fetchActivePriorConfigs(engine, ctx)
        : new Map<string, DeviceConfigRow>()

      // 2) Map firmware → mapped batch. The mapper owns the
      //    dataType → metric translation; no consumer translator needed.
      const mapped = mapFirmwareExport(fw, ctx, { activePriorConfigs })

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
                AND metric = $data_type
                AND valid_to IS NULL`,
            {
              valid_to: close.valid_to.toISOString(),
              device_id: close.device_id,
              metric: close.metric,
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
        ['device_battery', asRows(mapped.device_battery)],
        ['device_config', asRows(mapped.device_config)],
      ]
      for (const [table, rows] of mappedTables) {
        if (!rows || rows.length === 0)
          continue
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
      // A user-initiated flush is one batch too — otherwise a manual sync
      // would evaluate rules per table and reintroduce the race that
      // strictBatchOrdering exists to close.
      const batchId = flusher.beginBatch('manual')
      const results: FlushResult[] = []
      try {
        for (const table of tables) {
          results.push(await flusher.flush(table, 'manual', batchId))
          triggers.noteDrain(table)
        }
      }
      finally {
        flusher.endBatch(batchId)
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
