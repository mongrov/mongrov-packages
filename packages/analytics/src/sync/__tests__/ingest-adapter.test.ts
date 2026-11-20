/**
 * `SensorSink.ingest` — a pack's ingest adapter maps raw output to rows by
 * table; the engine validates each table's rows with the table's
 * `validate`, counts the drops, and buffers the rest (S-02).
 */

import type { AnalyticsEngine, AttachContext } from '../../core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { registerPack, resetPacks } from '../../core/packs'
import { DROPPED_ROWS_EVENT } from '../drops'
import { createSyncManager } from '../factory'
import { createFakeEngine } from './__fakes__/fake-engine'

const ctx: AttachContext = { brand: 'b', tenantScope: 'family', tenantId: 'fam', userId: 'u1' }
const who = { brand: 'b', familyId: 'fam', userId: 'u1', deviceId: 'd1' }

const READING = {
  ddl: 'CREATE TABLE reading (\n  ts TIMESTAMP NOT NULL,\n  brand VARCHAR NOT NULL,\n  value INTEGER\n);',
  timeColumn: 'ts',
  syncable: true,
  retention: null,
  validate: (rows: readonly Record<string, unknown>[]) => {
    const kept = rows.filter(r => r.value != null)
    return { kept, dropped: rows.length - kept.length, reasons: rows.length > kept.length ? { no_value: rows.length - kept.length } : {}, nulled: 0 }
  },
}

function manager(opts: { fake?: ReturnType<typeof createFakeEngine>, logger?: ReturnType<typeof makeLogger>, mode?: 'local' | 'r2' } = {}) {
  const engine = (opts.fake ?? createFakeEngine()).engine as unknown as AnalyticsEngine
  if (opts.mode)
    (engine as { mode: string }).mode = opts.mode
  return createSyncManager({
    analytics: engine,
    storage: createFakeKV().kv,
    ctx,
    tables: ['reading'],
    columnOrder: { reading: ['ts', 'brand', 'value'] },
    prefetchPolicy: { kind: 'lazy' },
    logger: opts.logger,
  })
}

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

afterEach(() => resetPacks())

describe('SensorSink.ingest', () => {
  it('maps through the named adapter, validates per table, and buffers what is kept', async () => {
    const seen: unknown[] = []
    registerPack({
      name: 'gadget',
      tables: { reading: READING },
      ingest: {
        gadget: {
          async ingest(raw: Array<number | null>, c, deps) {
            seen.push({ raw, user: c.userId, tables: deps.tables })
            return [['reading', raw.map(v => ({ ts: '2026-01-01T00:00:00Z', brand: c.brand, value: v }))]]
          },
        },
      },
    })
    const mgr = manager()
    await mgr.sink.ingest('gadget', [1, null, 3], who)
    expect(seen).toEqual([{ raw: [1, null, 3], user: 'u1', tables: ['reading'] }])
    expect(await mgr.sink.pendingRowCount('reading')).toBe(2)
  })

  it('rejects an adapter nobody registered, buffering nothing', async () => {
    const mgr = manager()
    await expect(mgr.sink.ingest('nope', {}, who)).rejects.toThrow(/no ingest adapter "nope"/)
    expect(await mgr.sink.pendingRowCount()).toBe(0)
  })

  it('push validates with the same declared validator', async () => {
    registerPack({ name: 'gadget', tables: { reading: READING } })
    const mgr = manager()
    await mgr.sink.push({ table: 'reading', ...who, rows: [{ ts: '2026-01-01T00:00:00Z', brand: 'b', value: null }] })
    expect(await mgr.sink.pendingRowCount('reading')).toBe(0)
  })
})

describe('post-flush jobs', () => {
  it('see the rows buffered for each table and run inside every flush, before it closes', async () => {
    const noted: string[] = []
    const runs: string[] = []
    registerPack({
      name: 'gadget',
      tables: { reading: READING },
      postFlush: [{
        name: 'count',
        create: deps => deps.tables.includes('reading')
          ? {
              noteRows: (table, batch) => noted.push(`${table}:${batch.rows.length}`),
              run: async (_batchId, reason) => {
                runs.push(reason)
                return []
              },
            }
          : undefined,
      }],
    })
    const mgr = manager()
    await mgr.sink.push({ table: 'reading', ...who, rows: [{ ts: '2026-01-01T00:00:00Z', brand: 'b', value: 1 }] })
    await mgr.sink.flush()
    expect(noted).toEqual(['reading:1'])
    expect(runs).toEqual(['manual'])
  })
})

/**
 * A table whose validator drops rows with no value or a malformed `ts`, and
 * keeps a row whose value is the device's `-1` "no value" sentinel with the
 * value set to NULL (counted as nulled).
 */
const VALIDATED = {
  ...READING,
  validate: (rows: readonly Record<string, unknown>[]) => {
    const kept: Record<string, unknown>[] = []
    const reasons: Record<string, number> = {}
    let nulled = 0
    for (const r of rows) {
      const reason = r.value == null ? 'no_value' : Number.isNaN(Date.parse(String(r.ts))) ? 'bad_timestamp' : undefined
      if (reason) {
        reasons[reason] = (reasons[reason] ?? 0) + 1
        continue
      }
      if (r.value === -1) {
        nulled += 1
        kept.push({ ...r, value: null })
        continue
      }
      kept.push(r)
    }
    return { kept, dropped: rows.length - kept.length, reasons, nulled }
  },
}

const row = (value: number | null, ts = '2026-01-01T00:00:00Z') => ({ ts, brand: 'b', value })
function dropLines(logger: ReturnType<typeof makeLogger>) {
  return [...logger.warn.mock.calls, ...logger.info.mock.calls].filter(([msg]) => msg === DROPPED_ROWS_EVENT)
}

describe('rows dropped at ingest are reported once per flush', () => {
  it('one warn line per flush, by table and reason, then reset', async () => {
    registerPack({ name: 'gadget', tables: { reading: VALIDATED } })
    const logger = makeLogger()
    const fake = createFakeEngine()
    const mgr = manager({ fake, logger })

    await mgr.sink.push({ table: 'reading', ...who, rows: [row(1), row(null), row(2, 'garbage')] })
    await mgr.sink.push({ table: 'reading', ...who, rows: [row(null)] })
    // Nothing is logged per push.
    expect(dropLines(logger)).toHaveLength(0)
    expect(await mgr.sink.pendingRowCount('reading')).toBe(1)

    await mgr.sink.flush()
    expect(fake.appended.filter(a => a.table === 'reading').map(a => a.values[2])).toEqual([1])
    expect(logger.warn).toHaveBeenCalledWith(DROPPED_ROWS_EVENT, expect.objectContaining({
      trigger: 'manual',
      total: 3,
      dropped: { reading: { no_value: 2, bad_timestamp: 1 } },
      nulled: {},
    }))

    // The counts belong to that flush: the next one has nothing to report.
    await mgr.sink.flush()
    expect(dropLines(logger)).toHaveLength(1)
  })

  it('counts what an ingest adapter produced with the same validator', async () => {
    registerPack({
      name: 'gadget',
      tables: { reading: VALIDATED },
      ingest: {
        gadget: { ingest: async (raw: Array<number | null>) => [['reading', raw.map(v => row(v))]] },
      },
    })
    const logger = makeLogger()
    const mgr = manager({ logger })
    await mgr.sink.ingest('gadget', [5, null], who)
    await mgr.sink.flush()
    expect(logger.warn).toHaveBeenCalledWith(DROPPED_ROWS_EVENT, expect.objectContaining({
      total: 1,
      dropped: { reading: { no_value: 1 } },
    }))
  })

  it('the scheduled flush reports the same line', async () => {
    registerPack({ name: 'gadget', tables: { reading: VALIDATED } })
    const logger = makeLogger()
    const mgr = manager({ logger })
    await mgr.sink.push({ table: 'reading', ...who, rows: [row(1), row(null)] })
    await mgr.triggerNow()
    expect(logger.warn).toHaveBeenCalledWith(DROPPED_ROWS_EVENT, expect.objectContaining({ trigger: 'scheduled', total: 1 }))
  })

  it('only nulled values: the line is info, not warn, and the row is kept', async () => {
    registerPack({ name: 'gadget', tables: { reading: VALIDATED } })
    const logger = makeLogger()
    const fake = createFakeEngine()
    const mgr = manager({ fake, logger })
    await mgr.sink.push({ table: 'reading', ...who, rows: [row(-1)] })
    await mgr.sink.flush()
    expect(fake.appended.filter(a => a.table === 'reading').map(a => a.values[2])).toEqual([null])
    expect(logger.info).toHaveBeenCalledWith(DROPPED_ROWS_EVENT, expect.objectContaining({ total: 0, nulled: { reading: 1 } }))
    expect(logger.warn.mock.calls.filter(([msg]) => msg === DROPPED_ROWS_EVENT)).toHaveLength(0)
  })

  it('a clean flush logs nothing', async () => {
    registerPack({ name: 'gadget', tables: { reading: VALIDATED } })
    const logger = makeLogger()
    const mgr = manager({ logger })
    await mgr.sink.push({ table: 'reading', ...who, rows: [row(1)] })
    await mgr.sink.flush()
    expect(dropLines(logger)).toHaveLength(0)
  })
})

describe('an ingest adapter may use the local catalog before rows are buffered', () => {
  it('runs deps.execute on the attached engine, then buffers what it returns', async () => {
    const fake = createFakeEngine()
    fake.mockExecuteNext([{ value: 7 }])
    registerPack({
      name: 'gadget',
      tables: { reading: READING },
      ingest: {
        gadget: {
          async ingest(_raw: unknown, c, deps) {
            const prior = await deps.execute<{ value: number }>('SELECT value FROM memory.main.reading WHERE brand = $brand', { brand: c.brand })
            await deps.execute('UPDATE memory.main.reading SET value = NULL WHERE brand = $brand', { brand: c.brand })
            return [['reading', prior.map(p => row(p.value + 1))]]
          },
        },
      },
    })
    const mgr = manager({ fake })
    await mgr.sink.ingest('gadget', {}, who)
    expect(fake.executeCalls.map(c => [c.sql.split(' ')[0], c.params])).toEqual([
      ['SELECT', { brand: 'b' }],
      ['UPDATE', { brand: 'b' }],
    ])
    expect(await mgr.sink.pendingRowCount('reading')).toBe(1)
  })
})

describe('after-push hooks write through pushRemote', () => {
  function hookPack(calls: unknown[]) {
    registerPack({
      name: 'gadget',
      tables: { reading: READING },
      sync: {
        afterPush: async (c, deps) => {
          const result = await deps.pushRemote('reading', async (remoteTable, execute) => {
            await execute(`UPDATE ${remoteTable} SET value = NULL WHERE brand = $brand`, { brand: c.brand })
            return 1
          })
          calls.push(result)
        },
      },
    })
  }

  it('r2 mode: the hook runs each scheduled cycle against the tenant\'s remote table', async () => {
    const calls: unknown[] = []
    hookPack(calls)
    const fake = createFakeEngine()
    const mgr = manager({ fake, mode: 'r2' })
    await mgr.triggerNow()
    expect(calls).toEqual([{ table: 'reading', rowsPushed: 1, ok: true }])
    const update = fake.executeCalls.find(c => c.sql.startsWith('UPDATE'))
    expect(update?.sql).toBe('UPDATE zone_fam.default.reading SET value = NULL WHERE brand = $brand')
  })

  it('local mode: there is no remote, so the hook does not run', async () => {
    const calls: unknown[] = []
    hookPack(calls)
    const mgr = manager({ mode: 'local' })
    await mgr.triggerNow()
    expect(calls).toEqual([])
  })
})
