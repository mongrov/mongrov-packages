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
