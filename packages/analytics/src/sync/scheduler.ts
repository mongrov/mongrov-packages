/**
 * T-22 + T-23 + T-24 — SyncScheduler.
 *
 * Wraps `expo-background-task` via an injected `BackgroundTaskPort` so unit
 * tests can drive registration/dispatch without touching the native module.
 *
 * A cycle runs: constraint check → flush → push → fetch → (optional rules).
 * Constraints (wifi + charging) are queried via `ConstraintPort`; failing
 * checks emit a debug log and skip the cycle with `SyncError('constraint_not_met')`.
 * `triggerNow()` bypasses constraints and always runs (T-24).
 *
 * Design.md §sync/scheduler.ts is the source of truth for the surface.
 */

import type { AttachContext } from '../core/types'
import { describeError } from '../core/errors'
import { SyncError } from './errors'

/**
 * Injected wrapper around `expo-background-task`. Kept minimal — start/stop
 * plus a fire-once dispatch hook the caller uses to run the cycle for tests.
 */
export interface BackgroundTaskPort {
  register: (taskName: string, handler: () => Promise<void>) => Promise<void>
  unregister: (taskName: string) => Promise<void>
  isRegistered: (taskName: string) => Promise<boolean>
}

/** Battery + network gates that decide whether a scheduled cycle runs. */
export interface ConstraintPort {
  isCharging: () => Promise<boolean>
  isOnWifi: () => Promise<boolean>
}

/** Sync operations the scheduler drives per cycle. */
export interface SyncCoordinator {
  /**
   * May report which tables failed to flush; the scheduler logs it. A
   * failed table keeps its rows buffered, so the cycle carries on.
   */
  flushAll: () => Promise<void | FlushAllSummary>
  /** Per-table results; failed tables are named in the cycle summary. */
  pushAll: (tables: string[], ctx: AttachContext) => Promise<StepResult[]>
  /**
   * SCD-2 close directives (`device_config.valid_to = now()`) pending
   * against the remote Iceberg zone. Drained + pushed between `pushAll`
   * and `fetchIncremental` so the fetch step sees consistent closes.
   * Optional — only wired when `tables` includes `'device_config'`.
   */
  pushClosesForDeviceConfig?: (ctx: AttachContext) => Promise<void>
  fetchIncremental: (ctx: AttachContext) => Promise<StepResult[]>
  /**
   * Day-first baseline recompute (Sprint 5 T-15). Runs AFTER fetch so the
   * quantiles see rows that just arrived from R2, not just locally-flushed
   * ones — a baseline computed before the fetch would be short a day on
   * every multi-device family. Optional; failures never fail the cycle.
   */
  computeBaselines?: () => Promise<void>
  onCycleComplete?: () => Promise<void>
}

export interface FlushAllSummary {
  failedTables: string[]
  rowsFlushed: number
}

/** One table's push or fetch outcome, as the scheduler reads it. */
export interface StepResult {
  ok: boolean
  table?: string
  rowsPushed?: number
  rowsFetched?: number
}

/**
 * Matches `@mongrov/core`'s logger shape narrowly. `error` is optional so
 * existing three-method loggers still fit; without it errors log at `warn`.
 */
export interface SchedulerLogger {
  debug: (msg: string, meta?: Record<string, unknown>) => void
  info: (msg: string, meta?: Record<string, unknown>) => void
  warn: (msg: string, meta?: Record<string, unknown>) => void
  error?: (msg: string, meta?: Record<string, unknown>) => void
}

/**
 * Log at `error`, or at `warn` for a logger without `error` (the method is
 * optional on `SchedulerLogger`).
 */
export function logError(
  logger: SchedulerLogger | undefined,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  if (!logger)
    return
  const log = logger.error ?? logger.warn
  log.call(logger, msg, meta)
}

function failedTablesOf(results: readonly StepResult[]): string[] {
  return results.filter(r => !r.ok).map(r => r.table ?? '?')
}

function sumOf(results: readonly StepResult[], key: 'rowsPushed' | 'rowsFetched'): number {
  return results.reduce((sum, r) => sum + (r[key] ?? 0), 0)
}

export interface SchedulerConstraints {
  /** Require Wi-Fi (skip on cellular). Default: true. */
  requireWifi?: boolean
  /** Require the device to be charging. Default: false. */
  requireCharging?: boolean
}

export interface SyncSchedulerConfig {
  backgroundTask: BackgroundTaskPort
  constraints: ConstraintPort
  coordinator: SyncCoordinator
  /** Tables to push each cycle. */
  tables: string[]
  /** Attach context to run against. */
  ctx: AttachContext
  /** Task name registered with the background scheduler. */
  taskName?: string
  constraintPolicy?: SchedulerConstraints
  logger?: SchedulerLogger
}

export type SchedulerState = 'idle' | 'running' | 'error'

export interface CycleResult {
  ok: boolean
  skipped: boolean
  reason?: 'constraint_not_met'
  error?: SyncError
}

const DEFAULT_TASK_NAME = '@mongrov/analytics:sync'

const noopLogger: SchedulerLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
}

export class SyncScheduler {
  readonly #config: Required<
    Pick<SyncSchedulerConfig, 'backgroundTask' | 'constraints' | 'coordinator' | 'tables' | 'ctx' | 'taskName' | 'logger'>
  > & { constraintPolicy: Required<SchedulerConstraints> }

  #state: SchedulerState = 'idle'
  #subscribers = new Set<(state: SchedulerState) => void>()

  constructor(config: SyncSchedulerConfig) {
    this.#config = {
      backgroundTask: config.backgroundTask,
      constraints: config.constraints,
      coordinator: config.coordinator,
      tables: config.tables,
      ctx: config.ctx,
      taskName: config.taskName ?? DEFAULT_TASK_NAME,
      logger: config.logger ?? noopLogger,
      constraintPolicy: {
        requireWifi: config.constraintPolicy?.requireWifi ?? true,
        requireCharging: config.constraintPolicy?.requireCharging ?? false,
      },
    }
  }

  get state(): SchedulerState {
    return this.#state
  }

  subscribe(fn: (state: SchedulerState) => void): () => void {
    this.#subscribers.add(fn)
    return () => this.#subscribers.delete(fn)
  }

  async start(): Promise<void> {
    await this.#config.backgroundTask.register(this.#config.taskName, async () => {
      await this.#runCycle(false)
    })
    this.#config.logger.info('scheduler.start', { taskName: this.#config.taskName })
  }

  async stop(): Promise<void> {
    await this.#config.backgroundTask.unregister(this.#config.taskName)
    this.#config.logger.info('scheduler.stop', { taskName: this.#config.taskName })
  }

  async isRegistered(): Promise<boolean> {
    return this.#config.backgroundTask.isRegistered(this.#config.taskName)
  }

  /** T-24 — manual trigger bypasses constraints. */
  async triggerNow(): Promise<CycleResult> {
    return this.#runCycle(true)
  }

  async #runCycle(bypassConstraints: boolean): Promise<CycleResult> {
    // Skips are `info`: once per wake-up, and the only record of why a
    // scheduled sync did not run.
    if (this.#state === 'running') {
      this.#config.logger.info('scheduler.cycle.skip', { reason: 'already_running' })
      return { ok: false, skipped: true }
    }

    if (!bypassConstraints) {
      let allowed: boolean
      try {
        allowed = await this.#checkConstraints()
      }
      catch (cause) {
        // A throwing constraint port used to reject the background task
        // handler with nothing logged.
        logError(this.#config.logger, 'scheduler.cycle.constraints_failed', { error: describeError(cause) })
        return {
          ok: false,
          skipped: true,
          error: new SyncError('constraint_not_met', 'Constraint check failed', cause),
        }
      }
      if (!allowed) {
        this.#config.logger.info('scheduler.cycle.skip', { reason: 'constraint_not_met' })
        return {
          ok: false,
          skipped: true,
          reason: 'constraint_not_met',
          error: new SyncError('constraint_not_met', 'Battery/network constraints not satisfied'),
        }
      }
    }

    this.#setState('running')
    const startedAt = Date.now()
    try {
      const flushed = await this.#config.coordinator.flushAll()
      const pushed = await this.#config.coordinator.pushAll(this.#config.tables, this.#config.ctx)
      await this.#config.coordinator.pushClosesForDeviceConfig?.(this.#config.ctx)
      const fetched = await this.#config.coordinator.fetchIncremental(this.#config.ctx)
      // Baselines are derived data — a failure here leaves the previous
      // (still-valid) rows in place and must not mark the cycle failed,
      // which would otherwise strand the scheduler in `error` and stop
      // future flushes over a stale percentile.
      if (this.#config.coordinator.computeBaselines) {
        try {
          await this.#config.coordinator.computeBaselines()
        }
        catch (cause) {
          this.#config.logger.warn('scheduler.cycle.baselines_failed', {
            error: describeError(cause),
          })
        }
      }
      await this.#config.coordinator.onCycleComplete?.()
      // `info`, once per cycle: the only record that a scheduled sync ran.
      // It used to say `ok` at debug even when every table failed to flush.
      // Push and fetch results were awaited and dropped: a table that never
      // reached R2 still logged `ok`.
      const failedTables = flushed?.failedTables ?? []
      const pushFailedTables = failedTablesOf(pushed ?? [])
      const fetchFailedTables = failedTablesOf(fetched ?? [])
      const summary = {
        durationMs: Date.now() - startedAt,
        rowsFlushed: flushed?.rowsFlushed,
        failedTables,
        rowsPushed: sumOf(pushed ?? [], 'rowsPushed'),
        pushFailedTables,
        rowsFetched: sumOf(fetched ?? [], 'rowsFetched'),
        fetchFailedTables,
      }
      if (failedTables.length + pushFailedTables.length + fetchFailedTables.length > 0)
        this.#config.logger.warn('scheduler.cycle.partial', summary)
      else
        this.#config.logger.info('scheduler.cycle.ok', summary)
      this.#setState('idle')
      return { ok: true, skipped: false }
    }
    catch (cause) {
      logError(this.#config.logger, 'scheduler.cycle.error', {
        durationMs: Date.now() - startedAt,
        error: describeError(cause),
      })
      this.#setState('error')
      return {
        ok: false,
        skipped: false,
        error: new SyncError('flush_failed', 'Sync cycle failed', cause),
      }
    }
  }

  async #checkConstraints(): Promise<boolean> {
    const { requireWifi, requireCharging } = this.#config.constraintPolicy
    if (requireWifi) {
      const wifi = await this.#config.constraints.isOnWifi()
      if (!wifi)
        return false
    }
    if (requireCharging) {
      const charging = await this.#config.constraints.isCharging()
      if (!charging)
        return false
    }
    return true
  }

  #setState(next: SchedulerState): void {
    this.#state = next
    for (const fn of this.#subscribers) fn(next)
  }
}
