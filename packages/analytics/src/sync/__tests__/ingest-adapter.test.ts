/**
 * `SensorSink.ingest` — a pack's ingest adapter maps raw output to rows by
 * table; the engine validates each table's rows with the table's
 * `validate`, counts the drops, and buffers the rest (S-02).
 */

import type { AnalyticsEngine, AttachContext } from '../../core/types'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { registerPack, resetPacks } from '../../core/packs'
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

function manager() {
  return createSyncManager({
    analytics: createFakeEngine().engine as unknown as AnalyticsEngine,
    storage: createFakeKV().kv,
    ctx,
    tables: ['reading'],
    columnOrder: { reading: ['ts', 'brand', 'value'] },
    prefetchPolicy: { kind: 'lazy' },
  })
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
