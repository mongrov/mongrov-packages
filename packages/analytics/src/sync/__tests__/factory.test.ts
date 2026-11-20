/**
 * T-26 — `createSyncManager` factory.
 *
 * Coverage:
 *   1. Zod validation rejects malformed config (missing columnOrder).
 *   2. Assembly returns a manager with all expected surfaces + methods.
 *   3. `sink.push` forwards batches to the buffer (pendingRowCount reflects it).
 *   4. `sink.flush` drains all configured tables and returns FlushResult[].
 *   5. `progress()` tracks lastFlushAt after a flush event.
 *   6. `state()` reflects scheduler transitions via subscribe.
 *   7. `triggerNow()` executes the coordinator cycle.
 *   8. Event bus receives `{table}:insert` after a flush.
 */

import type { AnalyticsEngine, AttachContext } from '../../core/types'

import type { EventBus } from '../events'
import { describe, expect, it, vi } from 'vitest'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { createSyncManager } from '../factory'
import { createFakeEngine } from './__fakes__/fake-engine'

const ctx: AttachContext = {
  brand: 'acme',
  tenantScope: 'family',
  tenantId: 'fam_A',
  userId: 'u1',
}

function makeAnalytics(): AnalyticsEngine {
  const fake = createFakeEngine()
  return fake.engine as unknown as AnalyticsEngine
}

function makeBus(): EventBus & { calls: Array<{ name: string, payload: unknown }> } {
  const calls: Array<{ name: string, payload: unknown }> = []
  return {
    calls,
    emit: (name, payload) => calls.push({ name, payload }),
  }
}

function baseConfig() {
  return {
    analytics: makeAnalytics(),
    storage: createFakeKV().kv,
    ctx,
    tables: ['hrv', 'heart_rate'] as const,
    columnOrder: {
      hrv: ['user_id', 'device_id', 'ts', 'rmssd_ms'] as const,
      heart_rate: ['user_id', 'device_id', 'ts', 'bpm'] as const,
    },
    prefetchPolicy: { kind: 'lazy' } as const,
  }
}

describe('createSyncManager — validation', () => {
  it('throws ZodError on empty tables array', () => {
    expect(() => createSyncManager({
      ...baseConfig(),
      tables: [] as unknown as readonly string[],
    })).toThrow()
  })

  it('throws ZodError on negative flush.maxRows', () => {
    expect(() => createSyncManager({
      ...baseConfig(),
      flush: { maxRows: -1 },
    })).toThrow()
  })
})

describe('createSyncManager — assembly', () => {
  it('returns manager with all expected surfaces', () => {
    const mgr = createSyncManager(baseConfig())
    expect(mgr.analytics).toBeDefined()
    expect(mgr.sink).toBeDefined()
    expect(mgr.flusher).toBeDefined()
    expect(mgr.pusher).toBeDefined()
    expect(mgr.fetcher).toBeDefined()
    expect(mgr.scheduler).toBeDefined()
    expect(typeof mgr.state).toBe('function')
    expect(typeof mgr.progress).toBe('function')
    expect(typeof mgr.subscribe).toBe('function')
    expect(typeof mgr.triggerNow).toBe('function')
    expect(typeof mgr.prefetch).toBe('function')
  })

  it('initial state is idle with zero progress', () => {
    const mgr = createSyncManager(baseConfig())
    expect(mgr.state().scheduler).toBe('idle')
    const prog = mgr.progress()
    expect(prog.pendingByTable).toEqual({})
    expect(prog.lastFlushAt).toBeUndefined()
    expect(prog.lastSyncCompleteAt).toBeUndefined()
  })
})

describe('SensorSink', () => {
  it('push forwards to buffer; pendingRowCount reflects it', async () => {
    const mgr = createSyncManager(baseConfig())
    await mgr.sink.push({
      table: 'hrv',
      brand: 'acme',
      familyId: 'fam_A',
      userId: 'u1',
      deviceId: 'ring',
      rows: [{ user_id: 'u1', device_id: 'ring', ts: '2026-10-28T08:00:00.000Z', rmssd_ms: 42 }],
    })
    const count = await mgr.sink.pendingRowCount('hrv')
    expect(count).toBe(1)
  })

  it('flush drains all configured tables', async () => {
    const mgr = createSyncManager(baseConfig())
    await mgr.sink.push({
      table: 'hrv',
      brand: 'acme',
      familyId: 'fam_A',
      userId: 'u1',
      deviceId: 'ring',
      rows: [{ user_id: 'u1', device_id: 'ring', ts: '2026-10-28T08:00:00.000Z', rmssd_ms: 42 }],
    })
    const results = await mgr.sink.flush()
    expect(results).toHaveLength(2) // hrv + heart_rate
  })

  it('clear resets buffer to empty', async () => {
    const mgr = createSyncManager(baseConfig())
    await mgr.sink.push({
      table: 'hrv',
      brand: 'acme',
      familyId: 'fam_A',
      userId: 'u1',
      deviceId: 'ring',
      rows: [{ user_id: 'u1', device_id: 'ring', ts: '2026-10-28T08:00:00.000Z', rmssd_ms: 42 }],
    })
    await mgr.sink.clear()
    expect(await mgr.sink.pendingRowCount()).toBe(0)
  })
})

describe('event bus + progress', () => {
  it('progress.lastFlushAt updates after a successful flush event', async () => {
    const bus = makeBus()
    const mgr = createSyncManager({ ...baseConfig(), eventBus: bus })
    await mgr.sink.push({
      table: 'hrv',
      brand: 'acme',
      familyId: 'fam_A',
      userId: 'u1',
      deviceId: 'ring',
      rows: [{ user_id: 'u1', device_id: 'ring', ts: '2026-10-28T08:00:00.000Z', rmssd_ms: 42 }],
    })
    await mgr.sink.flush()
    expect(mgr.progress().lastFlushAt).toBeTypeOf('number')
    // Bus received insert events (for both tables — heart_rate had 0 rows so it may or may not emit).
    const inserts = bus.calls.filter(c => c.name.endsWith(':insert'))
    expect(inserts.length).toBeGreaterThanOrEqual(1)
    expect(inserts[0]!.name).toBe('hrv:insert')
  })
})

describe('rules-engine integration', () => {
  it('calls rulesEngine.evaluateOnBatch after a successful flush', async () => {
    const evaluateOnBatch = vi.fn().mockResolvedValue([])
    const rulesEngine = {
      register: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      list: vi.fn(() => []),
      getActive: vi.fn(() => []),
      evaluateOnBatch,
      evaluateScheduled: vi.fn(),
      on: vi.fn(() => () => {}),
      subscribeRegistry: vi.fn(() => () => {}),
    }
    const mgr = createSyncManager({ ...baseConfig(), rulesEngine })
    await mgr.sink.push({
      table: 'hrv',
      brand: 'acme',
      familyId: 'fam_A',
      userId: 'u1',
      deviceId: 'ring',
      rows: [{ user_id: 'u1', device_id: 'ring', ts: '2026-10-28T08:00:00.000Z', rmssd_ms: 42 }],
    })
    await mgr.sink.flush()
    // Flush drains both configured tables. Only hrv had rows, so evaluate is
    // called exactly once with the hrv summary.
    expect(evaluateOnBatch).toHaveBeenCalledTimes(1)
    expect(evaluateOnBatch).toHaveBeenCalledWith({
      affectedUserIds: ['u1'],
      affectedTables: ['hrv'],
    })
  })

  it('skips rulesEngine when every row already existed (0 inserted, app#460 P17)', async () => {
    const evaluateOnBatch = vi.fn().mockResolvedValue([])
    const rulesEngine = {
      register: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      list: vi.fn(() => []),
      getActive: vi.fn(() => []),
      evaluateOnBatch,
      evaluateScheduled: vi.fn(),
      on: vi.fn(() => () => {}),
      subscribeRegistry: vi.fn(() => () => {}),
    }
    const fake = createFakeEngine()
    const execute = fake.engine.execute.bind(fake.engine)
    // DuckDB's answer to an INSERT that ON CONFLICT kept every row out of.
    fake.engine.execute = (async (sql: string, params?: Record<string, unknown>) =>
      sql.startsWith('INSERT INTO hrv') ? [{ Count: 0 }] : execute(sql, params)) as typeof fake.engine.execute
    const mgr = createSyncManager({ ...baseConfig(), analytics: fake.engine as unknown as AnalyticsEngine, rulesEngine })
    await mgr.sink.push({
      table: 'hrv',
      brand: 'acme',
      familyId: 'fam_A',
      userId: 'u1',
      deviceId: 'ring',
      rows: [{ user_id: 'u1', device_id: 'ring', ts: '2026-10-28T08:00:00.000Z', rmssd_ms: 42 }],
    })
    await mgr.sink.flush()
    expect(evaluateOnBatch).not.toHaveBeenCalled()
  })

  it('skips rulesEngine when no userIds were affected (empty drain)', async () => {
    const evaluateOnBatch = vi.fn().mockResolvedValue([])
    const rulesEngine = {
      register: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      list: vi.fn(() => []),
      getActive: vi.fn(() => []),
      evaluateOnBatch,
      evaluateScheduled: vi.fn(),
      on: vi.fn(() => () => {}),
      subscribeRegistry: vi.fn(() => () => {}),
    }
    const mgr = createSyncManager({ ...baseConfig(), rulesEngine })
    // Nothing pushed — flush drains empty buffers, no affectedUserIds.
    await mgr.sink.flush()
    expect(evaluateOnBatch).not.toHaveBeenCalled()
  })

  it('calls rulesEngine.evaluateScheduled after triggerNow completes', async () => {
    const evaluateScheduled = vi.fn().mockResolvedValue([])
    const rulesEngine = {
      register: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      list: vi.fn(() => []),
      getActive: vi.fn(() => []),
      evaluateOnBatch: vi.fn().mockResolvedValue([]),
      evaluateScheduled,
      on: vi.fn(() => () => {}),
      subscribeRegistry: vi.fn(() => () => {}),
    }
    const mgr = createSyncManager({ ...baseConfig(), rulesEngine })
    const result = await mgr.triggerNow()
    expect(result.ok).toBe(true)
    expect(evaluateScheduled).toHaveBeenCalledTimes(1)
  })

  it('swallows evaluateScheduled throws — cycle still reports ok', async () => {
    const evaluateScheduled = vi.fn().mockRejectedValue(new Error('scheduled blew up'))
    const rulesEngine = {
      register: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      list: vi.fn(() => []),
      getActive: vi.fn(() => []),
      evaluateOnBatch: vi.fn().mockResolvedValue([]),
      evaluateScheduled,
      on: vi.fn(() => () => {}),
      subscribeRegistry: vi.fn(() => () => {}),
    }
    const warn = vi.fn()
    const mgr = createSyncManager({
      ...baseConfig(),
      rulesEngine,
      logger: { debug: () => {}, info: () => {}, warn },
    })
    const result = await mgr.triggerNow()
    expect(result.ok).toBe(true)
    expect(evaluateScheduled).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
  })

  it('does not stall sync when rulesEngine throws', async () => {
    const evaluateOnBatch = vi.fn().mockRejectedValue(new Error('rules blew up'))
    const rulesEngine = {
      register: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      list: vi.fn(() => []),
      getActive: vi.fn(() => []),
      evaluateOnBatch,
      evaluateScheduled: vi.fn(),
      on: vi.fn(() => () => {}),
      subscribeRegistry: vi.fn(() => () => {}),
    }
    const warn = vi.fn()
    const mgr = createSyncManager({
      ...baseConfig(),
      rulesEngine,
      logger: { debug: () => {}, info: () => {}, warn },
    })
    await mgr.sink.push({
      table: 'hrv',
      brand: 'acme',
      familyId: 'fam_A',
      userId: 'u1',
      deviceId: 'ring',
      rows: [{ user_id: 'u1', device_id: 'ring', ts: '2026-10-28T08:00:00.000Z', rmssd_ms: 42 }],
    })
    const results = await mgr.sink.flush()
    // Give the fire-and-forget catch a tick to run.
    await Promise.resolve()
    await Promise.resolve()
    expect(results.every(r => r.ok)).toBe(true)
    expect(evaluateOnBatch).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
  })
})

describe('scheduler wiring', () => {
  it('subscribe fires on scheduler transitions', async () => {
    const mgr = createSyncManager(baseConfig())
    const states: string[] = []
    mgr.subscribe(s => states.push(s.scheduler))
    await mgr.triggerNow()
    // Should have observed running and idle transitions.
    expect(states).toContain('running')
    expect(states).toContain('idle')
  })

  it('triggerNow returns a CycleResult', async () => {
    const mgr = createSyncManager(baseConfig())
    const result = await mgr.triggerNow()
    expect(result.ok).toBe(true)
  })
})

describe('wifi/charging gates by mode (#80)', () => {
  const LOCAL_GATES_EVENT = 'sync.factory: local mode — wifi/charging gates not used; nothing leaves the device'
  const NO_CONSTRAINTS_EVENT = 'sync.factory: no constraints supplied — wifi/charging gates are disabled'

  const makeLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })

  /** The fake engine carries no `mode`, so `baseConfig()` takes the r2 path. */
  function localAnalytics(): AnalyticsEngine {
    return { ...makeAnalytics(), mode: 'local' } as AnalyticsEngine
  }

  /** A port that says "cellular, on battery" to every probe. */
  function cellularOnBattery() {
    return {
      isOnWifi: vi.fn().mockResolvedValue(false),
      isCharging: vi.fn().mockResolvedValue(false),
    }
  }

  /** Captures the registered handler so a test can run a scheduled (gated) cycle. */
  function makeCapturingBackgroundTask() {
    const handlers = new Map<string, () => Promise<void>>()
    return {
      port: {
        register: async (name: string, handler: () => Promise<void>) => { handlers.set(name, handler) },
        unregister: async (name: string) => { handlers.delete(name) },
        isRegistered: async (name: string) => handlers.has(name),
      },
      runScheduledCycle: async () => {
        const [handler] = handlers.values()
        if (!handler)
          throw new Error('no handler registered')
        await handler()
      },
    }
  }

  it('local mode: a missing port is not a warning', () => {
    const logger = makeLogger()
    createSyncManager({ ...baseConfig(), analytics: localAnalytics(), logger })
    expect(logger.warn).not.toHaveBeenCalledWith(NO_CONSTRAINTS_EVENT)
    expect(logger.info).toHaveBeenCalledWith(LOCAL_GATES_EVENT, { constraintsSupplied: false })
  })

  it('local mode: a supplied port is not consulted, and a scheduled cycle runs on cellular', async () => {
    const logger = makeLogger()
    const constraints = cellularOnBattery()
    const bg = makeCapturingBackgroundTask()
    const mgr = createSyncManager({
      ...baseConfig(),
      analytics: localAnalytics(),
      constraints,
      backgroundTask: bg.port,
      scheduler: { requiresWifi: true, requiresCharging: true },
      logger,
    })
    await mgr.start()
    await bg.runScheduledCycle()
    expect(constraints.isOnWifi).not.toHaveBeenCalled()
    expect(constraints.isCharging).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith('scheduler.cycle.ok', expect.anything())
    expect(logger.info).not.toHaveBeenCalledWith('scheduler.cycle.skip', expect.anything())
    expect(logger.info).toHaveBeenCalledWith(LOCAL_GATES_EVENT, { constraintsSupplied: true })
    expect(logger.warn).not.toHaveBeenCalledWith(NO_CONSTRAINTS_EVENT)
  })

  it('r2 mode: a missing port still warns', () => {
    const logger = makeLogger()
    createSyncManager({ ...baseConfig(), logger })
    expect(logger.warn).toHaveBeenCalledWith(NO_CONSTRAINTS_EVENT)
    expect(logger.info).not.toHaveBeenCalledWith(LOCAL_GATES_EVENT, expect.anything())
  })

  it('r2 mode: a supplied port gates the scheduled cycle, and triggerNow still bypasses it (T-24)', async () => {
    const logger = makeLogger()
    const constraints = cellularOnBattery()
    const bg = makeCapturingBackgroundTask()
    const mgr = createSyncManager({ ...baseConfig(), constraints, backgroundTask: bg.port, logger })
    await mgr.start()
    await bg.runScheduledCycle()
    expect(constraints.isOnWifi).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith('scheduler.cycle.skip', { reason: 'constraint_not_met' })
    expect(logger.warn).not.toHaveBeenCalledWith(NO_CONSTRAINTS_EVENT)
    expect(logger.info).not.toHaveBeenCalledWith(LOCAL_GATES_EVENT, expect.anything())

    const result = await mgr.triggerNow()
    expect(result.ok).toBe(true)
    expect(constraints.isOnWifi).toHaveBeenCalledTimes(1)
  })
})

describe('strictBatchOrdering (Sprint 5 item (a))', () => {
  const makeRules = () => {
    const evaluateOnBatch = vi.fn().mockResolvedValue([])
    return {
      evaluateOnBatch,
      engine: {
        register: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
        list: vi.fn(() => []),
        getActive: vi.fn(() => []),
        evaluateOnBatch,
        evaluateScheduled: vi.fn(),
        on: vi.fn(() => () => {}),
        subscribeRegistry: vi.fn(() => () => {}),
      },
    }
  }

  const pushRow = (mgr: ReturnType<typeof createSyncManager>, table: string, userId: string) =>
    mgr.sink.push({
      table,
      brand: 'acme',
      familyId: 'fam_A',
      userId,
      deviceId: 'ring',
      rows: [{ user_id: userId, device_id: 'ring', ts: '2026-10-28T08:00:00.000Z', rmssd_ms: 42, bpm: 60 }],
    })

  it('evaluates ONCE per batch with every landed table, not once per table', async () => {
    const rules = makeRules()
    const mgr = createSyncManager({ ...baseConfig(), rulesEngine: rules.engine })

    await pushRow(mgr, 'hrv', 'u1')
    await pushRow(mgr, 'heart_rate', 'u1')
    await mgr.sink.flush()

    // Two tables flushed, but rules wake once — with both tables — so a
    // context-JOIN rule sees the complete write.
    expect(rules.evaluateOnBatch).toHaveBeenCalledTimes(1)
    const [arg] = rules.evaluateOnBatch.mock.calls[0]
    expect([...arg.affectedTables].sort()).toEqual(['heart_rate', 'hrv'])
    expect(arg.affectedUserIds).toEqual(['u1'])
  })

  it('reports only the tables that actually landed', async () => {
    // The negative case that motivates the whole change: a batch carrying
    // one table must not imply the others are present.
    const rules = makeRules()
    const mgr = createSyncManager({ ...baseConfig(), rulesEngine: rules.engine })

    await pushRow(mgr, 'hrv', 'u1')
    await mgr.sink.flush()

    expect(rules.evaluateOnBatch).toHaveBeenCalledWith({
      affectedUserIds: ['u1'],
      affectedTables: ['hrv'],
    })
  })

  it('opt-out restores the per-table trigger', async () => {
    const rules = makeRules()
    const mgr = createSyncManager({
      ...baseConfig(),
      rulesEngine: rules.engine,
      strictBatchOrdering: false,
    })

    await pushRow(mgr, 'hrv', 'u1')
    await pushRow(mgr, 'heart_rate', 'u1')
    await mgr.sink.flush()

    // One wake-up per table, each scoped to its own table — the 0.1.0
    // behaviour, and the race it carries.
    expect(rules.evaluateOnBatch).toHaveBeenCalledTimes(2)
    expect(rules.evaluateOnBatch).toHaveBeenCalledWith({
      affectedUserIds: ['u1'],
      affectedTables: ['hrv'],
    })
    expect(rules.evaluateOnBatch).toHaveBeenCalledWith({
      affectedUserIds: ['u1'],
      affectedTables: ['heart_rate'],
    })
  })

  it('emits batch:complete on the event bus with the batch summary', async () => {
    const emitted: { name: string, payload: unknown }[] = []
    const bus = { emit: (name: string, payload?: unknown) => emitted.push({ name, payload }) }
    const mgr = createSyncManager({ ...baseConfig(), eventBus: bus })

    await pushRow(mgr, 'hrv', 'u1')
    await mgr.sink.flush()

    const complete = emitted.find(e => e.name === 'batch:complete')
    expect(complete).toBeDefined()
    expect(complete!.payload).toMatchObject({
      affectedTables: ['hrv'],
      affectedUserIds: ['u1'],
      brand: 'acme',
      familyId: 'fam_A',
      rowCounts: { hrv: 1 },
    })
    // Per-table invalidation still fires — different consumer, different
    // timing requirement.
    expect(emitted.some(e => e.name === 'hrv:insert')).toBe(true)
  })

  it('emits no batch:complete when the flush drained nothing', async () => {
    const emitted: string[] = []
    const bus = { emit: (name: string) => { emitted.push(name) } }
    const mgr = createSyncManager({ ...baseConfig(), eventBus: bus })

    await mgr.sink.flush()

    expect(emitted).not.toContain('batch:complete')
  })
})

describe('flush failures reach the logger', () => {
  it('logs flush-failed with the cause chain — bindFlushEvents forwards only successes', async () => {
    const fake = createFakeEngine()
    for (let i = 0; i < 10; i++)
      fake.queueOpenError(new Error('TransactionException: appender aborted'))
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
    const mgr = createSyncManager({
      ...baseConfig(),
      analytics: fake.engine as unknown as AnalyticsEngine,
      logger,
    })
    await mgr.sink.push({
      table: 'hrv',
      brand: 'acme',
      familyId: 'fam_A',
      userId: 'u1',
      deviceId: 'ring',
      rows: [{ user_id: 'u1', device_id: 'ring', ts: '2026-10-28T08:00:00.000Z', rmssd_ms: 42 }],
    })

    const results = await mgr.sink.flush()

    expect(results.some(r => !r.ok)).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith('sync.flush.failed', expect.objectContaining({
      table: 'hrv',
      error: expect.stringContaining('appender aborted'),
    }))
  })
})
