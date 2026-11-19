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

import type { AppSchema } from '../core/app-schema'
import type { HybridDuckDB } from '../core/engine'
import type { IngestContext, PackSyncHooks } from '../core/packs'

import type { TableName } from '../core/schemas'
import type { AnalyticsEngine, AttachContext, KVStore } from '../core/types'
import type { RulesEngine } from '../rules/types'
import type { EventBus } from './events'
import type { FetchResult, PrefetchPolicy } from './fetcher'
import type { SyncEmitter } from './flusher'
import type { SensorSink, SyncManager, SyncManagerState, SyncProgress } from './manager'
import type {
  FirmwareExport,
  MapperContext,
  RingConfigTranslator,
} from './mapper/types'
import type { PushResult } from './pusher'
import type { BackgroundTaskPort, ConstraintPort, SchedulerLogger, SchedulerState } from './scheduler'
import type { SleepDeriver } from './sleep-derive'
import type { FlushResult, OverflowPolicy, SensorBatch } from './types'
import { z } from 'zod'
import { describeError } from '../core/errors'
import { ingestAdapter, packExtensions } from '../core/packs'
import { createBaselineComputer } from './baseline-compute'
import { SensorBuffer } from './buffer'
import { DROPPED_ROWS_EVENT, DropTally, validateRows } from './drops'
import { SyncError } from './errors'
import { bindFlushEvents, bindPushEvents } from './events'
import { R2Fetcher } from './fetcher'
import { BatchFlusher, MAX_CONSECUTIVE_FAILURES } from './flusher'
import { OverflowStore } from './overflow'
import { R2Pusher } from './pusher'
import { logError, SyncScheduler } from './scheduler'
import { createSleepDeriver, mergeFlushResults } from './sleep-derive'

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
  /**
   * Wi-Fi + charging probes gating scheduled cycles in `r2` mode (the
   * transfer to and from R2). Never consulted in local mode, where nothing
   * leaves the device (#80). Omitting it in `r2` mode logs a warning and
   * runs every scheduled cycle on any network.
   */
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
  /**
   * Derive sleep_session / sleep_stage from sleep_raw with the correction
   * pipeline inside each batch cycle (sleep-correction §3). Default true;
   * active only when sleep_raw, sleep_session and sleep_stage are all in
   * `tables`.
   */
  correctSleep?: boolean
  logger?: SchedulerLogger
  /**
   * The app's own tables (principle 71) — the same object given to
   * `createAnalytics`. Needed only when `tables` lists one of them, so the
   * pusher and fetcher bound it on its declared `timeColumn`.
   */
  appSchema?: AppSchema
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
  // `drop-newest` discards whole pushes once the ring is full, and nothing
  // was listening. One line on the first drop, then every 50th, so a stuck
  // buffer shows up without flooding the export.
  let droppedPushes = 0
  let droppedRows = 0
  const buffer = new SensorBuffer({
    overflow,
    maxBufferBytes: config.overflow?.maxBufferBytes,
    policy: config.overflow?.policy,
    onDrop: ({ table, droppedRowCount }) => {
      droppedPushes += 1
      droppedRows += droppedRowCount
      // `error`: drop-newest overflow discards the readings for good.
      if (droppedPushes % 50 === 1) {
        logError(config.logger, 'sync.buffer.dropped', { table, droppedRowCount, droppedPushes, droppedRows })
      }
    },
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
        // The evaluator swallows its own per-rule failures, so reaching
        // here is unexpected.
        logError(rulesLogger, 'sync.factory: rulesEngine.evaluateOnBatch threw', {
          trigger: label,
          err: describeError(err),
        })
      })
  }

  const flushEmitter: SyncEmitter = (event) => {
    // The flusher's failures and dropped rows were emitted but never logged:
    // `bindFlushEvents` forwards only successes, so a table that failed to
    // land, or rows rejected for good, left no trace in an exported log.
    if (event.type === 'flush-failed') {
      // `warn` while the rows are kept for a retry; `error` once the table
      // has used its retry budget and sits in `error` until a flush lands.
      const failures = flusher.failureCountOf(event.payload.table)
      const meta = {
        table: event.payload.table,
        code: event.payload.error.code,
        failures,
        error: describeError(event.payload.error),
      }
      if (failures >= MAX_CONSECUTIVE_FAILURES)
        logError(config.logger, 'sync.flush.failed', meta)
      else
        config.logger?.warn('sync.flush.failed', meta)
    }
    if (event.type === 'flushed' && (event.payload.rowsRejected ?? 0) > 0) {
      // `error`: poison-row isolation has discarded these rows for good.
      logError(config.logger, 'sync.flush.rows_rejected', {
        table: event.payload.table,
        reason: event.payload.reason,
        rowsRejected: event.payload.rowsRejected,
        rowsFlushed: event.payload.rowsFlushed,
        sample: event.payload.rejectedSample,
      })
    }
    if (event.type === 'flushed') {
      progress.pendingByTable[event.payload.table] = 0
      progress.lastFlushAt = Date.now()
      if (!strictBatchOrdering && event.payload.rowsInserted > 0) {
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
      // Only tables that inserted NEW rows (zivaone_app#460 P17): a re-sync of
      // rows already held flushes every table and changes nothing a rule can
      // see, and each rule reads the full-history quality views.
      evaluateRules(
        event.payload.insertedTables as TableName[],
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
      // expected: no Intl on a bare JS host (CI); UTC is the documented fallback.
      return 'UTC'
    }
  }

  async function resolveTimezone(userId: string): Promise<string> {
    if (!config.userTimezoneProvider)
      return deviceTimezone()
    try {
      return (await config.userTimezoneProvider(userId)) ?? deviceTimezone()
    }
    catch (err) {
      // A profile lookup failure must not skip the baseline entirely —
      // a baseline in the device zone is far better than none.
      config.logger?.warn('sync.factory: userTimezoneProvider threw; using device zone', {
        err: describeError(err),
      })
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
    logger: config.logger,
  })

  // Sleep sessions and stages are derived from sleep_raw by the correction
  // pipeline, inside each batch cycle (sleep-correction §3). Needs all three
  // tables subscribed; `correctSleep: false` opts out.
  // Step 5.6 reads the firmware's 10-minute step buckets, as v3.1 did
  // (staging.ts). Without `activity_bucket` subscribed the bucket table never
  // fills, which would read as "no movement" — so fall back to the 1-minute
  // rows, and say so once, rather than correct sleep on silent zero steps.
  const stepBuckets = config.tables.includes('activity_bucket')
  const sleepDeriver = config.correctSleep !== false
    && ['sleep_raw', 'sleep_session', 'sleep_stage'].every(t => config.tables.includes(t))
    ? createSleepDeriver({
        engine: config.analytics as unknown as HybridDuckDB,
        buffer,
        flusher,
        resolveTimezone,
        logger: config.logger,
        activitySteps: stepBuckets ? 'bucket' : 'minute',
      })
    : undefined
  if (sleepDeriver && !stepBuckets) {
    config.logger?.warn('sync.factory: activity_bucket not subscribed; sleep correction reads 1-minute steps, not the v3.1 10-minute buckets', {
      tables: config.tables.length,
    })
  }

  const watermark = new WatermarkStore({ kv: config.storage })

  const busPushEmit = config.eventBus ? bindPushEvents(config.eventBus) : undefined

  // A failed push keeps its watermark, so the rows go again next cycle:
  // `warn`. A token that could not be refreshed is an auth failure: `error`.
  function logPushFailure(result: PushResult): void {
    const meta = {
      table: result.table,
      code: result.error?.code,
      error: result.error ? describeError(result.error) : undefined,
    }
    if (result.error?.code === 'token_expired')
      logError(config.logger, 'sync.push.failed', meta)
    else
      config.logger?.warn('sync.push.failed', meta)
  }

  // Fetch failures were returned and dropped. One line per call, naming
  // every failed table — the watermark did not move, so the next fetch
  // retries them.
  function logFetchResults(label: string, results: FetchResult[], startedAt: number): FetchResult[] {
    const failed = results.filter(r => !r.ok)
    const summary = {
      durationMs: Date.now() - startedAt,
      tables: results.length,
      rowsFetched: results.reduce((sum, r) => sum + r.rowsFetched, 0),
    }
    if (failed.length > 0) {
      config.logger?.warn(`sync.${label}.failed`, {
        ...summary,
        failedTables: failed.map(r => r.table),
        firstError: failed[0]?.error ? describeError(failed[0].error) : undefined,
      })
    }
    else if (label === 'prefetch') {
      // Incremental fetches are summarised by `scheduler.cycle.ok`.
      config.logger?.info('sync.prefetch.ok', summary)
    }
    return results
  }
  const pusher = new R2Pusher({
    engine: engineAsHybrid,
    watermark,
    refreshToken: config.refreshToken,
    logger: config.logger,
    appSchema: config.appSchema,
    emit: (result) => {
      if (result.ok && result.rowsPushed > 0) {
        progress.lastSyncCompleteAt = Date.now()
      }
      if (!result.ok)
        logPushFailure(result)
      busPushEmit?.(result)
    },
  })

  const fetcher = new R2Fetcher({
    engine: engineAsHybrid,
    watermark,
    tables: [...config.tables],
    appSchema: config.appSchema,
  })

  // Local-mode gate: in `analytics.mode === 'local'` there's no remote R2
  // to push/fetch against. Instead of removing the pusher/fetcher entirely
  // (they're still returned on the SyncManager surface for consumers that
  // inspect them), we short-circuit the scheduler's coordinator hooks so
  // no push/fetch SQL actually runs. Rules still fire on-batch via the
  // flusher; scheduled rules also fire via `onCycleComplete`.
  const isLocal = config.analytics.mode === 'local'
  // Rows dropped at ingest (sink.push / pushFirmware) since the last flush;
  // each flush reports and resets it (spec §13 S10, T-60).
  const dropTally = new DropTally()

  const afterPushHooks = packExtensions<PackSyncHooks>('sync').flatMap(h => (h.afterPush ? [h.afterPush] : []))

  // Both fallbacks below are the right default — a consumer without an RN
  // background-task adapter should still get a SyncManager. What was wrong is
  // that they were silent (zivaone_app#74).
  //
  // `noopBackgroundTask()` stores the handler and never calls it, so
  // `scheduler.start()` registers a cycle that can never fire and still logs
  // success. Every scheduled path — flushAll, pushAll, fetchIncremental,
  // computeBaselines — becomes unreachable. The observable symptom is an
  // empty `user_baseline` with no error anywhere, which cost an afternoon and
  // three wrong hypotheses before anyone looked here.
  //
  // `alwaysAllowedConstraints()` silently disables the wifi/charging gates,
  // which starts mattering the moment cloud sync pushes to R2.
  if (!config.backgroundTask) {
    config.logger?.warn(
      'sync.factory: no backgroundTask supplied — scheduler cycles will never '
      + 'fire (flush, push, fetch and baseline compute are all unreachable)',
    )
  }

  // The gates exist for the transfer to and from R2. Local mode has no
  // transfer (`pushAll` / `fetchIncremental` are short-circuited below), so
  // it never consults them (#80): a missing port is not a warning there, and
  // a supplied one is not used. The scheduler checks the gate before the
  // whole cycle, so a port saying "no" would otherwise skip the local flush,
  // the sleep derivation, baselines and rules — none of which leave the
  // device. The warning is real in r2 mode: without a port, scheduled
  // cycles push and fetch on any network.
  const constraints = isLocal ? undefined : config.constraints
  if (isLocal) {
    config.logger?.info(
      'sync.factory: local mode — wifi/charging gates not used; nothing leaves the device',
      { constraintsSupplied: config.constraints !== undefined },
    )
  }
  else if (!constraints) {
    config.logger?.warn(
      'sync.factory: no constraints supplied — wifi/charging gates are disabled',
    )
  }

  const scheduler = new SyncScheduler({
    backgroundTask: config.backgroundTask ?? noopBackgroundTask(),
    constraints: constraints ?? alwaysAllowedConstraints(),
    coordinator: {
      flushAll: async () => {
        // One batch per scheduler cycle: rules see the whole cycle's write
        // as a single unit rather than one wake-up per table.
        const batchId = flusher.beginBatch('scheduled')
        try {
          const flushed = await Promise.all(
            config.tables.map(t => flusher.flush(t, 'scheduled', batchId)),
          )
          // After the raw tables land, before endBatch: corrected nights
          // are written into this batch so rules see them (never throws).
          // Their flush counts in the summary (zivaone_app#452).
          const results = mergeFlushResults(flushed, await sleepDeriver?.derive(batchId, 'scheduled') ?? [])
          // Reported, not thrown: a failed table keeps its rows buffered for
          // the next cycle, and the rest of the cycle (push, fetch,
          // baselines) should still run. The scheduler logs the summary.
          return {
            failedTables: results.filter(r => !r.ok).map(r => r.table),
            rowsFlushed: results.reduce((sum, r) => sum + r.rowsFlushed, 0),
          }
        }
        finally {
          // `finally` so a partial failure still closes the batch — the
          // tables that DID land are real writes and their consumers
          // should be woken. Leaving it open would leak the record and
          // silently suppress the next cycle's evaluation.
          flusher.endBatch(batchId)
          logDroppedRows(config.logger, dropTally, 'scheduled')
        }
      },
      pushAll: isLocal
        ? async () => []
        : async (tables, ctx) => pusher.pushAll(tables, ctx),
      // Packs' after-push steps (the ring's SCD-2 closes), r2 mode only:
      // there is no remote to replay against locally.
      afterPush: (isLocal || afterPushHooks.length === 0)
        ? undefined
        : async (ctx) => {
          for (const hook of afterPushHooks) {
            await hook(ctx, {
              pushRemote: (table, run) => pusher.pushRemote(table, ctx, run),
              storage: config.storage,
              tables: config.tables,
              logger: rulesLogger,
            })
          }
        },
      fetchIncremental: isLocal
        ? async () => []
        : async (ctx) => {
          const startedAt = Date.now()
          return logFetchResults('fetch', await fetcher.fetchIncremental(ctx), startedAt)
        },
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
            // expected: getFamilyMembers logs its own provider failure at
            // `error`; the signed-in user's baselines still refresh.
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
            logError(rulesLogger, 'sync.factory: rulesEngine.evaluateScheduled threw', {
              err: describeError(err),
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
    storage: config.storage,
    sleepDeriver,
    logger: config.logger,
    dropTally,
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
      : async (ctx) => {
        const startedAt = Date.now()
        return logFetchResults('prefetch', await fetcher.prefetchOnAttach(ctx, config.prefetchPolicy), startedAt)
      },
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
  storage: KVStore
  sleepDeriver?: SleepDeriver
  logger?: SchedulerLogger
  dropTally: DropTally
}

// The ring pack's SCD-2 statements, re-exported from where they always were.
export { ACTIVE_PRIOR_CONFIGS_SQL, CLOSE_DEVICE_CONFIG_SQL, closeDeviceConfigParams } from '../packs/ring/config-closes'

function createSensorSink(deps: CreateSinkDeps): SensorSink {
  const { buffer, flusher, triggers, tables, engine, attachCtx, storage, sleepDeriver, logger, dropTally } = deps

  const ingest = async (adapterName: string, raw: unknown, ctx: IngestContext): Promise<void> => {
    const adapter = ingestAdapter(adapterName)
    if (!adapter)
      throw new SyncError('push_failed', `no ingest adapter "${adapterName}" is registered`)
    const mapped = await adapter.ingest(raw, ctx, {
      execute: (sql, params) => engine.execute(sql, params),
      tables,
      storage,
      attach: attachCtx,
    })
    for (const [table, mappedRows] of mapped) {
      if (!mappedRows || mappedRows.length === 0)
        continue
      // Post-flush jobs see what the adapter produced, before validation.
      if (table === 'sleep_raw') {
        sleepDeriver?.noteRaw({
          brand: ctx.brand,
          familyId: ctx.familyId,
          userId: ctx.userId,
          deviceId: ctx.deviceId,
          rows: mappedRows as Record<string, unknown>[],
        })
      }
    }
    for (const [table, mappedRows] of mapped) {
      if (!mappedRows || mappedRows.length === 0)
        continue
      // Same ingest rule as `push` (spec §13 S10, T-60): only malformed
      // rows are dropped, counted for the next flush's log line; a value
      // outside the §13b clamps is stored and flagged by `v_*_q`. Tables
      // with no validator pass through untouched.
      const report = validateRows(table, mappedRows)
      dropTally.add(table, report)
      const rows = report.kept
      if (rows.length === 0)
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
  }

  return {
    push: async (input: SensorBatch) => {
      // The live path (spec §13 S10, T-60): malformed rows are dropped and
      // counted; out-of-range readings are stored for `_q` to flag.
      const report = validateRows(input.table, input.rows)
      dropTally.add(input.table, report)
      if (report.kept.length === 0)
        return
      const batch = report.dropped === 0 && report.nulled === 0 ? input : { ...input, rows: report.kept }
      await buffer.push(batch)
      triggers.noteEnqueue(batch.table, Date.now())
      if (batch.table === 'sleep_raw')
        sleepDeriver?.noteRaw(batch)
    },
    ingest,
    pushFirmware: async (fw: FirmwareExport, ctx: MapperContext) => ingest('firmware', fw, ctx),
    flush: async () => {
      // A user-initiated flush is one batch too — otherwise a manual sync
      // would evaluate rules per table and reintroduce the race that
      // strictBatchOrdering exists to close.
      const batchId = flusher.beginBatch('manual')
      const startedAt = Date.now()
      let results: FlushResult[] = []
      try {
        for (const table of tables) {
          results.push(await flusher.flush(table, 'manual', batchId))
          triggers.noteDrain(table)
        }
        // The derived sleep rows are flushed by the deriver, after the loop
        // drained `sleep_session` / `sleep_stage` empty — fold them in, or
        // the caller reads 0 for both (zivaone_app#452).
        results = mergeFlushResults(results, await sleepDeriver?.derive(batchId, 'manual') ?? [])
      }
      finally {
        flusher.endBatch(batchId)
      }
      logManualFlush(logger, results, startedAt)
      logDroppedRows(logger, dropTally, 'manual')
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

/**
 * The handoff summary for a manual flush — the app's post-sync write. Per-table
 * failures are already logged by the flush emitter; this is the one line that
 * says the handoff happened and how much landed.
 */
function logManualFlush(logger: SchedulerLogger | undefined, results: FlushResult[], startedAt: number): void {
  const failedTables = results.filter(r => !r.ok).map(r => r.table)
  const summary = {
    durationMs: Date.now() - startedAt,
    rowsFlushed: results.reduce((sum, r) => sum + r.rowsFlushed, 0),
    failedTables,
  }
  if (failedTables.length > 0)
    logger?.warn('sync.flush.manual.partial', summary)
  else
    logger?.info('sync.flush.manual.ok', summary)
}

/**
 * One line per flush with the rows dropped at ingest since the previous one,
 * by table and reason (spec §13 S10, T-60). Silent when nothing was dropped
 * or nulled. `warn` when rows were dropped; `info` when readings were only
 * nulled (a "no value" sentinel on a row that carries other readings,
 * routine on every sync).
 */
function logDroppedRows(logger: SchedulerLogger | undefined, tally: DropTally, trigger: 'manual' | 'scheduled'): void {
  const summary = tally.drain()
  if (!summary)
    return
  const meta = { trigger, ...summary }
  if (summary.total > 0)
    logger?.warn(DROPPED_ROWS_EVENT, meta)
  else
    logger?.info(DROPPED_ROWS_EVENT, meta)
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
