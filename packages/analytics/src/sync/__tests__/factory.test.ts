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

import { describe, expect, it, vi } from 'vitest'

import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import type { AnalyticsEngine, AttachContext } from '../../core/types'
import type { EventBus } from '../events'
import { createSyncManager } from '../factory'
import { createFakeEngine } from './__fakes__/fake-engine'

const ctx: AttachContext = {
  brand: 'ziva',
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

const baseConfig = () => ({
  analytics: makeAnalytics(),
  storage: createFakeKV().kv,
  ctx,
  tables: ['hrv', 'heart_rate'] as const,
  columnOrder: {
    hrv: ['user_id', 'device_id', 'ts', 'rmssd_ms'] as const,
    heart_rate: ['user_id', 'device_id', 'ts', 'bpm'] as const,
  },
  prefetchPolicy: { kind: 'lazy' } as const,
})

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

  it('throws when tables includes device_config but no ringConfigTranslator is provided', () => {
    expect(() => createSyncManager({
      ...baseConfig(),
      tables: ['hrv', 'device_config'],
      columnOrder: {
        hrv: ['user_id', 'device_id', 'ts', 'rmssd_ms'] as const,
        device_config: ['device_id', 'brand', 'family_id', 'user_id', 'data_type', 'interval_minutes', 'start_time', 'end_time', 'weeks', 'valid_from', 'valid_to'] as const,
      },
    })).toThrow(/ringConfigTranslator is required/)
  })

  it('accepts device_config when ringConfigTranslator is provided', () => {
    expect(() => createSyncManager({
      ...baseConfig(),
      tables: ['hrv', 'device_config'],
      columnOrder: {
        hrv: ['user_id', 'device_id', 'ts', 'rmssd_ms'] as const,
        device_config: ['device_id', 'brand', 'family_id', 'user_id', 'data_type', 'interval_minutes', 'start_time', 'end_time', 'weeks', 'valid_from', 'valid_to'] as const,
      },
      ringConfigTranslator: {
        metricToDataType: () => 1,
        dataTypeToMetric: () => 'hrv',
        windowToSchemaFields: () => ({ start_time: null, end_time: null, weeks: null }),
      },
    })).not.toThrow()
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
      brand: 'ziva',
      familyId: 'fam_A',
      userId: 'u1',
      deviceId: 'ring',
      rows: [{ user_id: 'u1', device_id: 'ring', ts: 't', rmssd_ms: 42 }],
    })
    const count = await mgr.sink.pendingRowCount('hrv')
    expect(count).toBe(1)
  })

  it('flush drains all configured tables', async () => {
    const mgr = createSyncManager(baseConfig())
    await mgr.sink.push({
      table: 'hrv',
      brand: 'ziva',
      familyId: 'fam_A',
      userId: 'u1',
      deviceId: 'ring',
      rows: [{ user_id: 'u1', device_id: 'ring', ts: 't1', rmssd_ms: 42 }],
    })
    const results = await mgr.sink.flush()
    expect(results).toHaveLength(2) // hrv + heart_rate
  })

  it('clear resets buffer to empty', async () => {
    const mgr = createSyncManager(baseConfig())
    await mgr.sink.push({
      table: 'hrv',
      brand: 'ziva',
      familyId: 'fam_A',
      userId: 'u1',
      deviceId: 'ring',
      rows: [{ user_id: 'u1', device_id: 'ring', ts: 't', rmssd_ms: 42 }],
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
      brand: 'ziva',
      familyId: 'fam_A',
      userId: 'u1',
      deviceId: 'ring',
      rows: [{ user_id: 'u1', device_id: 'ring', ts: 't1', rmssd_ms: 42 }],
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
      brand: 'ziva',
      familyId: 'fam_A',
      userId: 'u1',
      deviceId: 'ring',
      rows: [{ user_id: 'u1', device_id: 'ring', ts: 't1', rmssd_ms: 42 }],
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
      brand: 'ziva',
      familyId: 'fam_A',
      userId: 'u1',
      deviceId: 'ring',
      rows: [{ user_id: 'u1', device_id: 'ring', ts: 't1', rmssd_ms: 42 }],
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

describe('device_config sink (SCD-2 close semantics)', () => {
  const deviceConfigColumns = [
    'device_id', 'brand', 'family_id', 'user_id', 'data_type',
    'interval_minutes', 'start_time', 'end_time', 'weeks',
    'valid_from', 'valid_to',
  ] as const

  const translator = {
    metricToDataType: (m: string) => ({ hrv: 1, spo2: 2 } as Record<string, number>)[m] ?? 99,
    dataTypeToMetric: (d: number) => ({ 1: 'hrv', 2: 'spo2' } as Record<number, string>)[d] ?? 'unknown',
    windowToSchemaFields: (w: { start_hour: number, end_hour: number }) => ({
      start_time: `${String(w.start_hour).padStart(2, '0')}:00`,
      end_time: `${String(w.end_hour).padStart(2, '0')}:00`,
      weeks: 0x7F,
    }),
  }

  const emptyFirmware = {
    heartrate: [], hrv_table: [], spo2: [], temperature_table: [],
    activitydetails: [], sleep_processed: [], battery_table: [],
  }
  const mapperCtx = {
    brand: 'ziva', familyId: 'fam_A', userId: 'u1',
    deviceId: 'ring_1', userTimezone: 'UTC',
  }

  function makeMgr(fake: ReturnType<typeof createFakeEngine>) {
    return createSyncManager({
      ...baseConfig(),
      analytics: fake.engine as unknown as AnalyticsEngine,
      tables: ['device_config'],
      columnOrder: { device_config: deviceConfigColumns },
      ringConfigTranslator: translator,
    })
  }

  it('first install: pushFirmware pre-fetches (empty) → no closes → new insert buffered', async () => {
    const fake = createFakeEngine()
    fake.mockExecuteNext([]) // SELECT returns no prior configs
    const mgr = makeMgr(fake)

    await mgr.sink.pushFirmware({
      ...emptyFirmware,
      ring: { automaticMonitoringData: [
        { metric: 'hrv', interval_minutes: 5, start_hour: 22, end_hour: 8 },
      ] },
    }, mapperCtx)

    // 1 SELECT + 0 UPDATEs (no prior).
    expect(fake.executeCalls).toHaveLength(1)
    expect(fake.executeCalls[0]!.sql).toMatch(/SELECT device_id, brand, family_id/)
    expect(fake.executeCalls[0]!.sql).toMatch(/FROM memory\.main\.device_config/)
    expect(fake.executeCalls[0]!.sql).toMatch(/valid_to IS NULL/)
    expect(fake.executeCalls[0]!.params?.device_id).toBe('ring_1')

    // Inserted row is now buffered.
    expect(await mgr.sink.pendingRowCount('device_config')).toBe(1)
  })

  it('config change: SELECT returns prior → UPDATE issued for local close + new insert buffered', async () => {
    const fake = createFakeEngine()
    // SELECT returns one open HRV config.
    fake.mockExecuteNext([{
      device_id: 'ring_1', brand: 'ziva', family_id: 'fam_A', user_id: 'u1',
      data_type: 1, interval_minutes: 10,
      start_time: '22:00', end_time: '08:00', weeks: 0x7F,
      valid_from: '2026-06-01T00:00:00.000Z', valid_to: null,
    }])
    fake.mockExecuteNext([]) // UPDATE returns nothing.
    const mgr = makeMgr(fake)

    await mgr.sink.pushFirmware({
      ...emptyFirmware,
      ring: { automaticMonitoringData: [
        { metric: 'hrv', interval_minutes: 5, start_hour: 22, end_hour: 8 },
      ] },
    }, mapperCtx)

    // 1 SELECT + 1 UPDATE.
    expect(fake.executeCalls).toHaveLength(2)
    const update = fake.executeCalls[1]!
    expect(update.sql).toMatch(/UPDATE memory\.main\.device_config/)
    expect(update.sql).toMatch(/SET valid_to/)
    expect(update.sql).toMatch(/valid_to IS NULL/)
    expect(update.params?.data_type).toBe(1)
    expect(update.params?.device_id).toBe('ring_1')

    // New insert is buffered.
    expect(await mgr.sink.pendingRowCount('device_config')).toBe(1)
  })

  it('scheduler cycle drains pending closes via pushCloses UPDATE against remote', async () => {
    const fake = createFakeEngine()
    // 1. SELECT prior configs → returns one open HRV
    fake.mockExecuteNext([{
      device_id: 'ring_1', brand: 'ziva', family_id: 'fam_A', user_id: 'u1',
      data_type: 1, interval_minutes: 10,
      start_time: '22:00', end_time: '08:00', weeks: 0x7F,
      valid_from: '2026-06-01T00:00:00.000Z', valid_to: null,
    }])
    // 2. Local UPDATE returns nothing.
    fake.mockExecuteNext([])
    const mgr = makeMgr(fake)

    // pushFirmware enqueues + local-UPDATEs.
    await mgr.sink.pushFirmware({
      ...emptyFirmware,
      ring: { automaticMonitoringData: [
        { metric: 'hrv', interval_minutes: 5, start_hour: 22, end_hour: 8 },
      ] },
    }, mapperCtx)

    // 3. For the scheduler cycle:
    //    - flushAll → 1 SELECT MAX(valid_from) + 1 INSERT (pusher.pushAll)
    //    - Actually flushAll uses appender, not execute. pushAll runs SELECT+INSERT.
    // Queue enough responses for pushAll's SELECT MAX/COUNT.
    fake.mockExecuteNext([{ max_ts: null, row_count: 0 }]) // pushAll SELECT → no new rows
    // 4. pushClosesForDeviceConfig → 1 UPDATE (remote)
    fake.mockExecuteNext([])
    // 5. fetchIncremental will call execute too.
    fake.mockExecuteNext([{ max_ts: null, row_count: 0 }])
    fake.mockExecuteNext([])

    await mgr.triggerNow()

    // Verify a remote UPDATE (zone_*) was issued for the pending close.
    const remoteUpdate = fake.executeCalls.find(c =>
      c.sql.includes('UPDATE zone_fam_A.default.device_config'),
    )
    expect(remoteUpdate).toBeDefined()
    expect(remoteUpdate!.params?.family_id).toBe('fam_A')
    expect(remoteUpdate!.params?.data_type).toBe(1)
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
      brand: 'ziva',
      familyId: 'fam_A',
      userId,
      deviceId: 'ring',
      rows: [{ user_id: userId, device_id: 'ring', ts: 't1', rmssd_ms: 42, bpm: 60 }],
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
      brand: 'ziva',
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
