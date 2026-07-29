import { describe, expect, it, vi } from 'vitest'

import { AnalyticsError } from '../errors'
import { LAST_ATTACH_TTL_MS } from '../persistence'
import { createAnalytics } from '../factory'
import type { AnalyticsConfig, AnalyticsEngine, AnalyticsLogger, AnalyticsState, AttachContext, TokenResponse } from '../types'

import { createFakeDuckDB } from './__fakes__/fake-duckdb'
import { createFakeKV } from './__fakes__/fake-kv'

/**
 * Wait until the engine reaches one of `targets`. Falls back to a maximum
 * spin count (each iteration yields the event loop) so an unreachable target
 * fails the test rather than hanging.
 */
async function waitForState(
  engine: AnalyticsEngine,
  targets: readonly AnalyticsState[],
  maxSpins = 200,
): Promise<AnalyticsState> {
  const targetSet = new Set(targets)
  for (let i = 0; i < maxSpins; i++) {
    if (targetSet.has(engine.state)) return engine.state
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`waitForState: never reached ${targets.join('|')} (last=${engine.state})`)
}

const ATTACH_CTX: AttachContext = {
  brand: 'brandA',
  tenantScope: 'family',
  tenantId: 'fam123',
  userId: 'user-1',
}

interface Harness {
  config: AnalyticsConfig
  fakeDb: ReturnType<typeof createFakeDuckDB>
  kvStore: Map<string, unknown>
}

function buildHarness(): Harness {
  const fakeDb = createFakeDuckDB()
  const { kv, store } = createFakeKV()

  const tokenResponse: TokenResponse = {
    token: 'bearer-abc',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    scopeClaims: {
      brand: ATTACH_CTX.brand,
      tenantScope: ATTACH_CTX.tenantScope,
      tenantId: ATTACH_CTX.tenantId,
      permissions: ['read', 'write'],
    },
  }

  const config: AnalyticsConfig = {
    storage: kv,
    warehouseUriBuilder: (brand, scope, tenantId) => `s3://mongrov/${brand}/${scope}/${tenantId}/warehouse`,
    catalogEndpoint: 'https://catalog.mongrov.test',
    tokenVendor: {
      async fetch() {
        return tokenResponse
      },
    },
    familyMembersProvider: async () => [ATTACH_CTX.userId],
    retention: {},
  }

  return { config, fakeDb, kvStore: store }
}

describe('createAnalytics — surface + startup', () => {
  it('returns object with all AnalyticsEngine methods', () => {
    const { config, fakeDb } = buildHarness()
    const engine = createAnalytics(config, { duckdbFactory: fakeDb.factory })

    expect(typeof engine.attach).toBe('function')
    expect(typeof engine.detach).toBe('function')
    expect(typeof engine.execute).toBe('function')
    expect(typeof engine.stream).toBe('function')
    expect(typeof engine.createAppender).toBe('function')
    expect(typeof engine.subscribe).toBe('function')
    expect(typeof engine.setRetention).toBe('function')
    expect(typeof engine.close).toBe('function')
    expect(typeof engine.state).toBe('string')
  })

  it('kicks OPEN on start; state reports "opening" synchronously', async () => {
    const { config, fakeDb } = buildHarness()
    const engine = createAnalytics(config, { duckdbFactory: fakeDb.factory })

    // Synchronous read — machine is mid-openEngine actor invocation.
    expect(engine.state).toBe('opening')

    await waitForState(engine, ['ready'])
    expect(engine.state).toBe('ready')

    await engine.close()
  })

  it('defaultDuckdbFactory throws NotImplementedError on first open', async () => {
    const { config } = buildHarness()
    const engine = createAnalytics(config) // no internal.duckdbFactory
    await waitForState(engine, ['error'])
    expect(engine.state).toBe('error')
    await engine.close()
  })
})

describe('createAnalytics — attach / detach lifecycle', () => {
  it('attach() resolves on ATTACH success and lands in "attached"', async () => {
    const { config, fakeDb } = buildHarness()
    const engine = createAnalytics(config, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])
    expect(engine.state).toBe('ready')

    await engine.attach(ATTACH_CTX)
    expect(engine.state).toBe('attached')

    // Warehouse SECRET + ATTACH + 14 local + 14 remote = 28 schema DDLs
    // (0.5.0 now creates local + remote tables so the sink doesn't throw
    // on first append; see MIGRATIONS baseline).
    expect(fakeDb.calls.some(c => c.sql.includes('CREATE OR REPLACE SECRET'))).toBe(true)
    expect(fakeDb.calls.some(c => c.sql.includes('ATTACH'))).toBe(true)
    expect(fakeDb.calls.filter(c => c.sql.includes('CREATE TABLE IF NOT EXISTS')).length).toBe(28)

    await engine.close()
  })

  it('attach() rejects with AnalyticsError when tokenVendor fails', async () => {
    const { config, fakeDb } = buildHarness()
    const failingConfig: AnalyticsConfig = {
      ...config,
      tokenVendor: {
        async fetch() {
          throw new Error('vendor down')
        },
      },
    }
    const engine = createAnalytics(failingConfig, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])

    await expect(engine.attach(ATTACH_CTX)).rejects.toBeInstanceOf(AnalyticsError)
    expect(engine.state).toBe('error')

    await engine.close()
  })

  it('detach() returns to "ready" and clears warehouse state', async () => {
    const { config, fakeDb } = buildHarness()
    const engine = createAnalytics(config, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])
    await engine.attach(ATTACH_CTX)
    expect(engine.state).toBe('attached')

    await engine.detach()
    expect(engine.state).toBe('ready')
    expect(fakeDb.calls.some(c => c.sql.startsWith('DETACH'))).toBe(true)

    await engine.close()
  })
})

describe('createAnalytics — subscribe + close', () => {
  it('subscribe() notifies on every transition; unsub stops delivery', async () => {
    const { config, fakeDb } = buildHarness()
    const engine = createAnalytics(config, { duckdbFactory: fakeDb.factory })

    const observed: string[] = []
    const unsub = engine.subscribe(s => observed.push(s))

    await waitForState(engine, ['ready'])
    expect(observed).toContain('ready')

    unsub()
    const lastLen = observed.length

    await engine.attach(ATTACH_CTX)
    // No further deliveries after unsub.
    expect(observed.length).toBe(lastLen)

    await engine.close()
  })

  it('close() transitions to "idle" and stops the machine', async () => {
    const { config, fakeDb } = buildHarness()
    const engine = createAnalytics(config, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])
    await engine.attach(ATTACH_CTX)

    await engine.close()
    expect(engine.state).toBe('idle')
  })

})

describe('createAnalytics — retention + persistence (Phase 6)', () => {
  it('attach persists last-attach ctx; getLastAttach returns it', async () => {
    const { config, fakeDb, kvStore } = buildHarness()
    const engine = createAnalytics(config, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])
    await engine.attach(ATTACH_CTX)

    const restored = await engine.getLastAttach(ATTACH_CTX.brand)
    expect(restored).toEqual(ATTACH_CTX)
    expect(kvStore.has(`analytics:last-attach:${ATTACH_CTX.brand}`)).toBe(true)

    await engine.close()
  })

  it('detach clears the persisted last-attach ctx', async () => {
    const { config, fakeDb, kvStore } = buildHarness()
    const engine = createAnalytics(config, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])
    await engine.attach(ATTACH_CTX)
    expect(kvStore.has(`analytics:last-attach:${ATTACH_CTX.brand}`)).toBe(true)

    await engine.detach()
    expect(kvStore.has(`analytics:last-attach:${ATTACH_CTX.brand}`)).toBe(false)
    expect(await engine.getLastAttach(ATTACH_CTX.brand)).toBeNull()

    await engine.close()
  })

  it('getLastAttach returns null once stored ctx ages past 24h', async () => {
    const { config, fakeDb, kvStore } = buildHarness()
    const engine = createAnalytics(config, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])
    await engine.attach(ATTACH_CTX)

    // Rewrite the persisted attachedAt to be older than the TTL — the read
    // path treats it as stale.
    const key = `analytics:last-attach:${ATTACH_CTX.brand}`
    const record = kvStore.get(key) as { ctx: AttachContext, attachedAt: number }
    kvStore.set(key, { ...record, attachedAt: Date.now() - LAST_ATTACH_TTL_MS - 1_000 })

    expect(await engine.getLastAttach(ATTACH_CTX.brand)).toBeNull()

    await engine.close()
  })

  it('attach runs retention sweep when brand default is set', async () => {
    const { config, fakeDb } = buildHarness()
    const brandCfg: AnalyticsConfig = { ...config, retention: { [ATTACH_CTX.brand]: { days: 90 } } }
    const engine = createAnalytics(brandCfg, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])
    await engine.attach(ATTACH_CTX)

    // 12 DELETE statements — one per retention-managed table.
    const deletes = fakeDb.calls.filter(c => c.sql.startsWith('DELETE FROM'))
    expect(deletes.length).toBeGreaterThanOrEqual(12)
    // Sensor tables should use the 90d effective retention.
    expect(deletes.some(c => c.sql.includes('DELETE FROM') && c.sql.includes('hrv') && c.sql.includes(`INTERVAL '90 days'`))).toBe(true)
    // Insight uses fixed 90d.
    expect(deletes.some(c => c.sql.includes('.insight') && c.sql.includes(`INTERVAL '90 days'`))).toBe(true)
    // Audit uses fixed 30d.
    expect(deletes.some(c => c.sql.includes('.tool_call_audit') && c.sql.includes(`INTERVAL '30 days'`))).toBe(true)

    await engine.close()
  })

  it('attach skips sensor DELETE when brand default is 0 (still sweeps insight+audit)', async () => {
    const { config, fakeDb } = buildHarness()
    // No brand retention configured → effective = 0 → sweep short-circuits.
    const engine = createAnalytics(config, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])
    await engine.attach(ATTACH_CTX)

    const deletes = fakeDb.calls.filter(c => c.sql.startsWith('DELETE FROM'))
    // sweep() bails on effective <= 0 → no DELETE statements at all.
    expect(deletes).toHaveLength(0)

    await engine.close()
  })

  it('setRetention persists override and re-runs the sweep with the effective value', async () => {
    const { config, fakeDb, kvStore } = buildHarness()
    const brandCfg: AnalyticsConfig = { ...config, retention: { [ATTACH_CTX.brand]: { days: 60 } } }
    const engine = createAnalytics(brandCfg, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])
    await engine.attach(ATTACH_CTX)

    const beforeCalls = fakeDb.calls.length
    await engine.setRetention(180)

    // Override is persisted.
    const overrideKey = `analytics:retention:override:${ATTACH_CTX.brand}:${ATTACH_CTX.tenantId}:${ATTACH_CTX.userId}`
    expect(kvStore.has(overrideKey)).toBe(true)

    // Sensor sweep uses the higher of 60d brand vs 180d override → 180.
    const newDeletes = fakeDb.calls.slice(beforeCalls).filter(c => c.sql.startsWith('DELETE FROM'))
    expect(newDeletes.some(c => c.sql.includes('.hrv') && c.sql.includes(`INTERVAL '180 days'`))).toBe(true)

    await engine.close()
  })

  it('setRetention rejects when not attached', async () => {
    const { config, fakeDb } = buildHarness()
    const engine = createAnalytics(config, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])

    await expect(engine.setRetention(90)).rejects.toBeInstanceOf(AnalyticsError)

    await engine.close()
  })
})

function makeSpyLogger(): AnalyticsLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

describe('createAnalytics — logger integration (Phase 7)', () => {
  it('emits debug entries for state transitions', async () => {
    const { config, fakeDb } = buildHarness()
    const logger = makeSpyLogger()
    const engine = createAnalytics({ ...config, logger }, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])

    const debugCalls = (logger.debug as ReturnType<typeof vi.fn>).mock.calls
    const values = debugCalls
      .filter(args => args[0] === 'analytics.state')
      .map(args => (args[1] as { value: string }).value)
    expect(values).toContain('opening')
    expect(values).toContain('ready')

    await engine.close()
  })

  it('emits info on attach + detach + close milestones', async () => {
    const { config, fakeDb } = buildHarness()
    const logger = makeSpyLogger()
    const engine = createAnalytics({ ...config, logger }, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])

    await engine.attach(ATTACH_CTX)
    await engine.detach()
    await engine.close()

    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.map(args => args[0])
    expect(infoCalls).toContain('analytics.attached')
    expect(infoCalls).toContain('analytics.detached')
    expect(infoCalls).toContain('analytics.closed')
  })

  it('emits warn when last-attach persistence fails during attach (best-effort)', async () => {
    const { config, fakeDb } = buildHarness()
    const logger = makeSpyLogger()
    // Fail ONLY the last-attach persistence key; leave migration + retention
    // KV writes untouched so the machine's attach actor still succeeds and
    // the best-effort catch is exercised.
    const failingStorage = {
      ...config.storage,
      async set(key: string, value: unknown) {
        if (key.startsWith('analytics:last-attach:')) throw new Error('kv down')
        return config.storage.set(key, value)
      },
    }
    const engine = createAnalytics(
      { ...config, storage: failingStorage, logger },
      { duckdbFactory: fakeDb.factory },
    )
    await waitForState(engine, ['ready'])

    // Attach still succeeds despite persistence failure.
    await engine.attach(ATTACH_CTX)
    expect(engine.state).toBe('attached')

    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map(args => args[0])
    expect(warnCalls).toContain('analytics.persist.last_attach_failed')

    await engine.close()
  })

  it('emits warn when retention sweep fails during attach (best-effort)', async () => {
    const { config, fakeDb } = buildHarness()
    const logger = makeSpyLogger()
    // Non-zero brand default so sweep runs; scripted failure fires on first DELETE.
    const engine = createAnalytics(
      { ...config, logger, retention: { brandA: { days: 30 } } },
      { duckdbFactory: fakeDb.factory },
    )
    await waitForState(engine, ['ready'])
    fakeDb.failExecuteMatching(/^DELETE FROM /, new Error('disk full'))

    await engine.attach(ATTACH_CTX)
    expect(engine.state).toBe('attached')

    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map(args => args[0])
    expect(warnCalls).toContain('analytics.retention.sweep_failed')

    await engine.close()
  })

  it('does not blow up when no logger is provided (noop fallback)', async () => {
    const { config, fakeDb } = buildHarness()
    const noLoggerConfig: AnalyticsConfig = { ...config }
    delete (noLoggerConfig as { logger?: AnalyticsLogger }).logger

    const engine = createAnalytics(noLoggerConfig, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])
    await engine.attach(ATTACH_CTX)
    await engine.detach()
    await engine.close()

    expect(true).toBe(true)
  })
})

describe('createAnalytics — data-plane attached-state guard (T-21)', () => {
  it('execute() throws not_attached in ready state, passes through in attached', async () => {
    const { config, fakeDb } = buildHarness()
    const engine = createAnalytics(config, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])

    await expect(engine.execute('SELECT 1')).rejects.toMatchObject({
      code: 'not_attached',
      message: expect.stringContaining('execute requires an attached engine'),
    })

    await engine.attach(ATTACH_CTX)
    await expect(engine.execute('SELECT 1')).resolves.toBeDefined()
    await engine.close()
  })

  it('stream() throws not_attached in ready state', async () => {
    const { config, fakeDb } = buildHarness()
    const engine = createAnalytics(config, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])

    expect(() => engine.stream('SELECT 1')).toThrow(
      expect.objectContaining({
        code: 'not_attached',
        message: expect.stringContaining('stream requires an attached engine'),
      }),
    )
    await engine.close()
  })

  it('createAppender() throws not_attached in ready state', async () => {
    const { config, fakeDb } = buildHarness()
    const engine = createAnalytics(config, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])

    expect(() => engine.createAppender('hrv')).toThrow(
      expect.objectContaining({
        code: 'not_attached',
        message: expect.stringContaining("createAppender('hrv') requires an attached engine"),
      }),
    )
    await engine.close()
  })
})

describe('createAnalytics — duckdb tuning (T-22)', () => {
  it('applies memoryLimit + threads PRAGMAs after open() and before extensions', async () => {
    const { config, fakeDb } = buildHarness()
    const tunedConfig: AnalyticsConfig = {
      ...config,
      duckdb: { memoryLimit: '512MB', threads: '4' },
    }
    const engine = createAnalytics(tunedConfig, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])

    const pragmas = fakeDb.calls.map(c => c.sql)
    expect(pragmas).toContain("SET memory_limit = '512MB'")
    expect(pragmas).toContain('SET threads = 4')
    // PRAGMAs run before any extension LOAD.
    const memIdx = pragmas.findIndex(s => s === "SET memory_limit = '512MB'")
    const loadIdx = pragmas.findIndex(s => s.startsWith('LOAD '))
    expect(memIdx).toBeGreaterThanOrEqual(0)
    expect(memIdx).toBeLessThan(loadIdx)
    await engine.close()
  })

  it('skips both PRAGMAs when duckdb config is omitted', async () => {
    const { config, fakeDb } = buildHarness()
    const engine = createAnalytics(config, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['ready'])

    const pragmas = fakeDb.calls.map(c => c.sql)
    expect(pragmas.some(s => s.startsWith('SET memory_limit'))).toBe(false)
    expect(pragmas.some(s => s.startsWith('SET threads'))).toBe(false)
    await engine.close()
  })

  it('rejects invalid memoryLimit format', async () => {
    const { config, fakeDb } = buildHarness()
    const bad: AnalyticsConfig = { ...config, duckdb: { memoryLimit: '512 gigs' } }
    const engine = createAnalytics(bad, { duckdbFactory: fakeDb.factory })
    // Machine transitions to error; lastError carries the AnalyticsError.
    await waitForState(engine, ['error'])
    expect(engine.lastError).toBeInstanceOf(AnalyticsError)
    expect((engine.lastError as AnalyticsError).message).toContain(
      'invalid duckdb.memoryLimit',
    )
    await engine.close()
  })

  it('rejects invalid threads format', async () => {
    const { config, fakeDb } = buildHarness()
    const bad: AnalyticsConfig = { ...config, duckdb: { threads: 'four' } }
    const engine = createAnalytics(bad, { duckdbFactory: fakeDb.factory })
    await waitForState(engine, ['error'])
    expect(engine.lastError).toBeInstanceOf(AnalyticsError)
    expect((engine.lastError as AnalyticsError).message).toContain(
      'invalid duckdb.threads',
    )
    await engine.close()
  })
})
