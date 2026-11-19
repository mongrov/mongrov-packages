/**
 * A pack's post-flush job or after-push hook that throws is logged and
 * skipped: it must not abort the flush (or cycle) it follows, nor starve the
 * jobs and hooks registered after it.
 */

import type { AnalyticsEngine, AttachContext } from '../../core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
}

function manager(mode: 'local' | 'r2', logger: { debug: () => void, info: () => void, warn: (...a: unknown[]) => void, error: (...a: unknown[]) => void }) {
  const engine = createFakeEngine().engine as unknown as AnalyticsEngine
  ;(engine as { mode: string }).mode = mode
  return createSyncManager({
    analytics: engine,
    storage: createFakeKV().kv,
    ctx,
    tables: ['reading'],
    columnOrder: { reading: ['ts', 'brand', 'value'] },
    prefetchPolicy: { kind: 'lazy' },
    logger,
  })
}

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

afterEach(() => resetPacks())

describe('post-flush job isolation', () => {
  it('a throwing job is logged; the flush completes and later jobs still run', async () => {
    const ran: string[] = []
    registerPack({
      name: 'first',
      tables: { reading: READING },
      postFlush: [{
        name: 'explodes',
        create: () => ({
          noteRows: () => {
            throw new Error('note boom')
          },
          run: async () => {
            throw new Error('run boom')
          },
        }),
      }],
    })
    registerPack({
      name: 'second',
      postFlush: [{
        name: 'counts',
        create: () => ({
          noteRows: table => ran.push(`note:${table}`),
          run: async (_batchId, reason) => {
            ran.push(`run:${reason}`)
            return []
          },
        }),
      }],
    })
    const log = logger()
    const mgr = manager('local', log)
    await mgr.sink.push({ table: 'reading', ...who, rows: [{ ts: '2026-01-01T00:00:00Z', brand: 'b', value: 1 }] })
    const results = await mgr.sink.flush()

    expect(results.find(r => r.table === 'reading')?.rowsFlushed).toBe(1)
    expect(ran).toEqual(['note:reading', 'run:manual'])
    const msgs = log.error.mock.calls.map(c => c[0])
    expect(msgs).toContain('sync.post_flush.note_failed')
    expect(msgs).toContain('sync.post_flush.failed')
    expect(log.error.mock.calls.find(c => c[0] === 'sync.post_flush.failed')?.[1]).toMatchObject({ job: 'explodes' })
  })
})

describe('after-push hook isolation', () => {
  it('a throwing hook is logged; later hooks run and the cycle still completes', async () => {
    const ran: string[] = []
    registerPack({
      name: 'first',
      tables: { reading: READING },
      sync: {
        afterPush: async () => {
          throw new Error('replay boom')
        },
      },
    })
    registerPack({
      name: 'second',
      sync: {
        afterPush: async () => {
          ran.push('second')
        },
      },
    })
    const log = logger()
    const mgr = manager('r2', log)
    const result = await mgr.triggerNow()

    expect(ran).toEqual(['second'])
    expect(result.ok).toBe(true)
    expect(log.error.mock.calls.find(c => c[0] === 'sync.after_push.failed')?.[1]).toMatchObject({ pack: 'first' })
  })
})
