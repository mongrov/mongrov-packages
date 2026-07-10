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

import { SyncError } from './errors'
import type { AttachContext } from '../core/types'

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
  flushAll: () => Promise<void>
  pushAll: (tables: string[], ctx: AttachContext) => Promise<Array<{ ok: boolean }>>
  fetchIncremental: (ctx: AttachContext) => Promise<Array<{ ok: boolean }>>
  onCycleComplete?: () => Promise<void>
}

/** Debug/info logger — matches `@mongrov/core` shape narrowly. */
export interface SchedulerLogger {
  debug: (msg: string, meta?: Record<string, unknown>) => void
  info: (msg: string, meta?: Record<string, unknown>) => void
  warn: (msg: string, meta?: Record<string, unknown>) => void
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
    if (this.#state === 'running') {
      this.#config.logger.debug('scheduler.cycle.skip', { reason: 'already_running' })
      return { ok: false, skipped: true }
    }

    if (!bypassConstraints) {
      const allowed = await this.#checkConstraints()
      if (!allowed) {
        this.#config.logger.debug('scheduler.cycle.skip', { reason: 'constraint_not_met' })
        return {
          ok: false,
          skipped: true,
          reason: 'constraint_not_met',
          error: new SyncError('constraint_not_met', 'Battery/network constraints not satisfied'),
        }
      }
    }

    this.#setState('running')
    try {
      await this.#config.coordinator.flushAll()
      await this.#config.coordinator.pushAll(this.#config.tables, this.#config.ctx)
      await this.#config.coordinator.fetchIncremental(this.#config.ctx)
      await this.#config.coordinator.onCycleComplete?.()
      this.#config.logger.debug('scheduler.cycle.ok')
      this.#setState('idle')
      return { ok: true, skipped: false }
    }
    catch (cause) {
      this.#config.logger.warn('scheduler.cycle.error', { error: String(cause) })
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
      if (!wifi) return false
    }
    if (requireCharging) {
      const charging = await this.#config.constraints.isCharging()
      if (!charging) return false
    }
    return true
  }

  #setState(next: SchedulerState): void {
    this.#state = next
    for (const fn of this.#subscribers) fn(next)
  }
}
