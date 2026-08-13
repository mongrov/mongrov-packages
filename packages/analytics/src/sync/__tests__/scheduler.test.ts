/**
 * T-22 + T-23 + T-24 — SyncScheduler.
 *
 * Coverage:
 *   1. `start()` registers the task with the background port.
 *   2. `stop()` unregisters.
 *   3. Registered handler runs the full cycle (flush → push → fetch).
 *   4. Missing Wi-Fi skips the cycle with `constraint_not_met`.
 *   5. Missing charging (when required) skips the cycle.
 *   6. `triggerNow()` bypasses constraints and always runs.
 *   7. Cycle failure surfaces as `flush_failed` and moves state to `error`.
 *   8. `subscribe()` observes idle → running → idle transitions.
 */

import type { AttachContext } from '../../core/types'

import type {
  BackgroundTaskPort,
  ConstraintPort,
  SyncCoordinator,
} from '../scheduler'
import { describe, expect, it, vi } from 'vitest'
import { SyncScheduler } from '../scheduler'

const ctx: AttachContext = {
  brand: 'ziva',
  tenantScope: 'family',
  tenantId: 'fam_A',
  userId: 'u1',
}

function makeBackgroundTask(): BackgroundTaskPort & {
  handlers: Map<string, () => Promise<void>>
} {
  const handlers = new Map<string, () => Promise<void>>()
  return {
    handlers,
    register: async (name, h) => { handlers.set(name, h) },
    unregister: async (name) => { handlers.delete(name) },
    isRegistered: async name => handlers.has(name),
  }
}

function makeConstraints(wifi = true, charging = true): ConstraintPort {
  return {
    isOnWifi: vi.fn().mockResolvedValue(wifi),
    isCharging: vi.fn().mockResolvedValue(charging),
  }
}

function makeCoordinator(): SyncCoordinator & {
  flushAll: ReturnType<typeof vi.fn>
  pushAll: ReturnType<typeof vi.fn>
  fetchIncremental: ReturnType<typeof vi.fn>
} {
  return {
    flushAll: vi.fn().mockResolvedValue(undefined),
    pushAll: vi.fn().mockResolvedValue([{ ok: true }]),
    fetchIncremental: vi.fn().mockResolvedValue([{ ok: true }]),
  }
}

function newScheduler(overrides: {
  wifi?: boolean
  charging?: boolean
  requireWifi?: boolean
  requireCharging?: boolean
  coordinator?: SyncCoordinator
} = {}) {
  const bg = makeBackgroundTask()
  const constraints = makeConstraints(overrides.wifi ?? true, overrides.charging ?? true)
  const coordinator = overrides.coordinator ?? makeCoordinator()
  const scheduler = new SyncScheduler({
    backgroundTask: bg,
    constraints,
    coordinator,
    tables: ['hrv', 'hr'],
    ctx,
    constraintPolicy: {
      requireWifi: overrides.requireWifi ?? true,
      requireCharging: overrides.requireCharging ?? false,
    },
  })
  return { scheduler, bg, constraints, coordinator }
}

describe('SyncScheduler.start / stop', () => {
  it('start registers the task with the background port', async () => {
    const { scheduler, bg } = newScheduler()
    await scheduler.start()
    expect(await scheduler.isRegistered()).toBe(true)
    expect(bg.handlers.size).toBe(1)
  })

  it('stop unregisters the task', async () => {
    const { scheduler, bg } = newScheduler()
    await scheduler.start()
    await scheduler.stop()
    expect(await scheduler.isRegistered()).toBe(false)
    expect(bg.handlers.size).toBe(0)
  })

  it('registered handler runs the full cycle', async () => {
    const { scheduler, bg, coordinator } = newScheduler()
    await scheduler.start()
    const handler = [...bg.handlers.values()][0]!
    await handler()
    expect(coordinator.flushAll).toHaveBeenCalledOnce()
    expect(coordinator.pushAll).toHaveBeenCalledWith(['hrv', 'hr'], ctx)
    expect(coordinator.fetchIncremental).toHaveBeenCalledWith(ctx)
  })
})

describe('SyncScheduler constraints (T-23)', () => {
  it('skips the cycle when Wi-Fi is required but missing', async () => {
    const { scheduler, bg, coordinator } = newScheduler({ wifi: false })
    await scheduler.start()
    const handler = [...bg.handlers.values()][0]!
    // Handler swallows the CycleResult; assert side-effects: no work ran.
    await handler()
    expect(coordinator.flushAll).not.toHaveBeenCalled()
    expect(coordinator.pushAll).not.toHaveBeenCalled()
    expect(scheduler.state).toBe('idle')
  })

  it('skips the cycle when charging is required but missing', async () => {
    const { scheduler, bg, coordinator } = newScheduler({
      charging: false,
      requireCharging: true,
    })
    await scheduler.start()
    const handler = [...bg.handlers.values()][0]!
    await handler()
    expect(coordinator.flushAll).not.toHaveBeenCalled()
    expect(scheduler.state).toBe('idle')
  })
})

describe('SyncScheduler.triggerNow (T-24)', () => {
  it('bypasses constraints and runs even when Wi-Fi is off', async () => {
    const { scheduler, coordinator, constraints } = newScheduler({ wifi: false })
    const result = await scheduler.triggerNow()
    expect(result.ok).toBe(true)
    expect(result.skipped).toBe(false)
    expect(constraints.isOnWifi).not.toHaveBeenCalled()
    expect(coordinator.flushAll).toHaveBeenCalledOnce()
  })

  it('surfaces failures as flush_failed and moves state to error', async () => {
    const coordinator = makeCoordinator()
    coordinator.flushAll = vi.fn().mockRejectedValue(new Error('kaboom'))
    const { scheduler } = newScheduler({ coordinator })
    const result = await scheduler.triggerNow()
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('flush_failed')
    expect(scheduler.state).toBe('error')
  })

  it('subscribe observes idle → running → idle', async () => {
    const { scheduler } = newScheduler()
    const seen: string[] = []
    scheduler.subscribe(s => seen.push(s))
    await scheduler.triggerNow()
    expect(seen).toEqual(['running', 'idle'])
  })
})
