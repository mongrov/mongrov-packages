/**
 * `tool_call_audit` v3 (platform migration 3, analytics 0.62.0), against a
 * live local DuckDB:
 *   - the writer's columns are the DDL's (principle 62), and a batch of every
 *     path's rows, refused calls included, executes against the real table;
 *   - the migration on a database with the 0.61.1 shape keeps every row
 *     (new columns NULL), drops stale `__stg` / `__probe` mirrors
 *     (mongrov-packages#109), and is a no-op when run again;
 *   - a half-applied migration (some columns already added) completes.
 */

import type { AnalyticsEngine } from '../../core/types'
import { describe, expect, it } from 'vitest'
import { CURRENT_VERSION } from '../../__tests__/packs/legacy-tables'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { ensureMigrations, schemaVersionKey } from '../../core/migrations'
import { TOOL_CALL_AUDIT_V3_COLUMNS } from '../../core/platform-pack'
import { PLATFORM_SCHEMAS } from '../../core/platform-tables'
import { AUDIT_COLUMNS, createAuditWriter } from '../audit'
import { call, okOutcome, seriesTool, setup } from './support/structured'

const CTX = { brand: 'acme', tenantId: 'fam-1' }
const PLATFORM_KEY = 'analytics:pack_schema_version:platform:acme:fam-1'

/** `tool_call_audit` as 0.61.1 created it locally (PARTITIONED BY stripped). */
const V2_DDL = `CREATE TABLE memory.tool_call_audit (
  ts TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  requester_user_id VARCHAR NOT NULL,
  tool_name VARCHAR NOT NULL,
  args VARCHAR NOT NULL,
  result_bytes INTEGER,
  result_row_count INTEGER,
  latency_ms INTEGER,
  outcome VARCHAR NOT NULL,
  error_message VARCHAR
);`
const V2_COLUMNS = ['ts', 'brand', 'family_id', 'requester_user_id', 'tool_name', 'args', 'result_bytes', 'result_row_count', 'latency_ms', 'outcome', 'error_message']

async function bootReal() {
  const { createRealDuckDB } = await import('../../__integration__/setup/real-engine')
  const { HybridDuckDB } = await import('../../core/engine')
  const db = new HybridDuckDB(() => createRealDuckDB([]))
  await db.open()
  const sqls: string[] = []
  const execute = db.execute.bind(db)
  db.execute = (async (sql: string, params?: Record<string, unknown>) => {
    sqls.push(sql)
    return execute(sql, params)
  }) as typeof db.execute
  return { db, sqls }
}

function ddlColumns(ddl: string): string[] {
  const body = ddl.slice(ddl.indexOf('(') + 1, ddl.lastIndexOf(')'))
  return body.split('\n').map(l => l.trim()).filter(l => /^[a-z_]+ [A-Z]/.test(l)).map(l => l.split(' ')[0])
}

async function columns(db: { execute: <T>(sql: string) => Promise<T[]> }): Promise<{ name: string, type: string, notnull: boolean }[]> {
  return db.execute<{ name: string, type: string, notnull: boolean }>(`PRAGMA table_info('memory.tool_call_audit');`)
}

describe('the DDL contract (principle 62)', () => {
  it('the v3 columns are the DDL\'s, after the 0.61.1 columns, all nullable', () => {
    const cols = ddlColumns(PLATFORM_SCHEMAS.tool_call_audit)
    expect(cols).toEqual([...V2_COLUMNS, ...TOOL_CALL_AUDIT_V3_COLUMNS.map(([c]) => c)])
    for (const [c, type] of TOOL_CALL_AUDIT_V3_COLUMNS)
      expect(PLATFORM_SCHEMAS.tool_call_audit).toContain(`${c} ${type}${c === 'cached' ? '\n' : ','}`)
  })

  it('the writer fills exactly the DDL\'s columns, in order', () => {
    expect(AUDIT_COLUMNS).toEqual(ddlColumns(PLATFORM_SCHEMAS.tool_call_audit))
  })

  it('a batch of every path\'s rows, refused calls included, executes against the real table', async () => {
    const { db } = await bootReal()
    try {
      await ensureMigrations(db, createFakeKV().kv, CTX, { local: 'memory' })
      const engine = { execute: (sql: string, params?: Record<string, unknown>) => db.execute(sql, params) } as unknown as AnalyticsEngine
      const writer = createAuditWriter({ analytics: engine, batchSize: 100, flushIntervalMs: 60_000 })

      // Every path through the chain, with the real writer behind it.
      const { handle } = setup({ callLimit: { perTurn: 3 }, rateLimit: { perToolPerMinute: 4, perToolPerHour: 200, perUserPerMinute: 60 } })
      handle.auditWriter.record = writer.record
      const t = handle.add(seriesTool(input => (input.period === 'last_30_days' ? (() => { throw new Error('boom') })() : okOutcome())))
      handle.beginTurn({ id: 'answer-9' })
      await call(t, { userId: 'alice', period: 'this_week' }) // ok
      await call(t, { userId: 'alice', period: 'this_week' }) // cached
      await call(t, { userId: 'alice', period: 'bad' }) // invalid_args
      await call(t, { userId: 'alice', period: 'last_30_days' }) // internal
      await call(t, { userId: 'alice', period: 'last_7_days' }) // call_limit
      await writer.flush()

      const rows = await db.execute<Record<string, unknown>>(
        `SELECT outcome, result_status, error_code, result_digest, render_chars, truncated_items, turn_id, call_index, cached
         FROM memory.tool_call_audit ORDER BY call_index`,
      )
      expect(rows.map(r => [r.call_index, r.outcome, r.result_status, r.error_code, r.cached, r.turn_id])).toEqual([
        [1, 'success', 'ok', null, false, 'answer-9'],
        [2, 'success', 'ok', null, true, 'answer-9'],
        [3, 'invalid_args', 'error', 'invalid_args', false, 'answer-9'],
        [4, 'error', 'error', 'internal', false, 'answer-9'],
        [5, 'call_limit', 'error', 'call_limit', false, 'answer-9'],
      ])
      expect(rows.every(r => typeof r.result_digest === 'string' && (r.result_digest as string).length === 16)).toBe(true)
      expect(rows.every(r => typeof r.render_chars === 'number' && (r.render_chars as number) > 0)).toBe(true)
    }
    finally {
      await db.close()
    }
  })
})

describe('platform migration 3 against a live DuckDB', () => {
  it('a fresh database gets the v3 shape from step 1, and step 3 issues no DDL', async () => {
    const { db, sqls } = await bootReal()
    try {
      const { kv, store } = createFakeKV()
      await ensureMigrations(db, kv, CTX, { local: 'memory' })
      expect((await columns(db)).map(c => c.name)).toEqual(ddlColumns(PLATFORM_SCHEMAS.tool_call_audit))
      expect(store.get(PLATFORM_KEY)).toBe(3)
      expect(sqls.some(s => s.includes('ALTER TABLE memory.tool_call_audit'))).toBe(false)
    }
    finally {
      await db.close()
    }
  })

  it('an existing 0.61.1 database: rows kept with NULL in the new columns, stale mirrors dropped, then a no-op', async () => {
    const { db, sqls } = await bootReal()
    try {
      const { kv, store } = createFakeKV()
      // Everything an install on 0.61.1 has: the tables at the package
      // ledger's current version, platform at 2, and the 0.61.1 audit shape.
      await ensureMigrations(db, kv, CTX, { local: 'memory' })
      await db.execute('DROP TABLE memory.tool_call_audit;')
      await db.execute(V2_DDL)
      await db.execute(
        `INSERT INTO memory.tool_call_audit (ts, brand, family_id, requester_user_id, tool_name, args, result_bytes, result_row_count, latency_ms, outcome, error_message)
         VALUES (now(), 'acme', 'fam-1', 'alice', 'getText', '{}', 12, 1, 5, 'success', NULL),
                (now(), 'acme', 'fam-1', 'alice', 'getText', '{"days":0}', NULL, NULL, 1, 'error', 'invalid_args: Invalid arguments: days must be a whole number from 1 to 30 (got 0).')`,
      )
      // Mirrors a flusher would have built from the old shape (#109).
      await db.execute('CREATE TABLE memory.tool_call_audit__stg AS SELECT * FROM memory.tool_call_audit WHERE false;')
      await db.execute('CREATE TABLE memory.tool_call_audit__probe AS SELECT * FROM memory.tool_call_audit WHERE false;')
      store.set(PLATFORM_KEY, 2)
      expect(store.get(schemaVersionKey(CTX.brand, CTX.tenantId))).toBe(CURRENT_VERSION)

      sqls.length = 0
      await ensureMigrations(db, kv, CTX, { local: 'memory' })

      expect(store.get(PLATFORM_KEY)).toBe(3)
      const cols = await columns(db)
      expect(cols.map(c => c.name)).toEqual(ddlColumns(PLATFORM_SCHEMAS.tool_call_audit))
      for (const [c] of TOOL_CALL_AUDIT_V3_COLUMNS)
        expect(cols.find(x => x.name === c)!.notnull).toBe(false)
      const rows = await db.execute<Record<string, unknown>>('SELECT * FROM memory.tool_call_audit ORDER BY latency_ms DESC')
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ tool_name: 'getText', outcome: 'success', result_bytes: 12, result_status: null, cached: null, turn_id: null })
      expect(rows[1]).toMatchObject({ outcome: 'error', error_code: null })
      const mirrors = await db.execute<{ table_name: string }>(
        `SELECT table_name FROM duckdb_tables() WHERE table_name LIKE 'tool_call_audit__%'`,
      )
      expect(mirrors).toEqual([])
      expect(sqls.filter(s => s.startsWith('ALTER TABLE memory.tool_call_audit ADD COLUMN'))).toHaveLength(TOOL_CALL_AUDIT_V3_COLUMNS.length)

      // The writer's INSERT runs against the migrated table.
      const engine = { execute: (sql: string, params?: Record<string, unknown>) => db.execute(sql, params) } as unknown as AnalyticsEngine
      const writer = createAuditWriter({ analytics: engine })
      writer.record({
        ts: new Date(),
        brand: 'acme',
        familyId: 'fam-1',
        requesterUserId: 'alice',
        toolName: 'getSeries',
        args: {},
        resultBytes: 10,
        resultRowCount: 1,
        latencyMs: 3,
        outcome: 'success',
        errorMessage: null,
        resultStatus: 'ok',
        errorCode: null,
        resultDigest: '0123456789abcdef',
        renderChars: 10,
        truncatedItems: 0,
        turnId: 't',
        callIndex: 1,
        cached: false,
      })
      await writer.close()
      expect(await db.execute('SELECT * FROM memory.tool_call_audit')).toHaveLength(3)

      // Run step 3 again (as after a KV that never advanced): nothing to do.
      store.set(PLATFORM_KEY, 2)
      sqls.length = 0
      await ensureMigrations(db, kv, CTX, { local: 'memory' })
      expect(sqls.some(s => s.includes('ALTER TABLE') || s.includes('DROP TABLE'))).toBe(false)
      expect(await db.execute('SELECT * FROM memory.tool_call_audit')).toHaveLength(3)
    }
    finally {
      await db.close()
    }
  })

  it('a half-applied step 3 (some columns present) adds only the rest', async () => {
    const { db, sqls } = await bootReal()
    try {
      const { kv, store } = createFakeKV()
      await ensureMigrations(db, kv, CTX, { local: 'memory' })
      await db.execute('DROP TABLE memory.tool_call_audit;')
      await db.execute(V2_DDL)
      await db.execute('ALTER TABLE memory.tool_call_audit ADD COLUMN result_status VARCHAR;')
      await db.execute('ALTER TABLE memory.tool_call_audit ADD COLUMN error_code VARCHAR;')
      store.set(PLATFORM_KEY, 2)
      sqls.length = 0
      await ensureMigrations(db, kv, CTX, { local: 'memory' })
      expect(sqls.filter(s => s.startsWith('ALTER TABLE memory.tool_call_audit ADD COLUMN'))).toHaveLength(TOOL_CALL_AUDIT_V3_COLUMNS.length - 2)
      expect((await columns(db)).map(c => c.name)).toEqual(ddlColumns(PLATFORM_SCHEMAS.tool_call_audit))
    }
    finally {
      await db.close()
    }
  })
})
