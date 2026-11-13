/**
 * App-owned tables (principle 71): validation, create + migrate on attach,
 * retention, and the push/fetch watermark column.
 */

import type { AppSchema, AppTable } from '../app-schema'
import type { AnalyticsEngine, KVStore } from '../types'

import { describe, expect, it } from 'vitest'
import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { createFakeSqlEngine } from '../../sync/__tests__/__fakes__/fake-sql-engine'
import { R2Fetcher } from '../../sync/fetcher'
import { R2Pusher } from '../../sync/pusher'
import { WatermarkStore } from '../../sync/watermark'
import { appSchemaVersionKey, ensureAppSchema, validateAppSchema } from '../app-schema'
import { HybridDuckDB } from '../engine'
import { AnalyticsError } from '../errors'
import { createAnalytics } from '../factory'
import { schemaVersionKey } from '../migrations'
import { runRetentionSweep } from '../retention'
import { isSyncable, timeColumnFor } from '../table_metadata'
import { createFakeDuckDB } from './__fakes__/fake-duckdb'
import { createFakeKV } from './__fakes__/fake-kv'

const NOTE: AppTable = {
  ddl: `CREATE TABLE app_note (
  note_id VARCHAR PRIMARY KEY,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  written_at TIMESTAMP NOT NULL,
  body VARCHAR
) PARTITIONED BY (day(written_at));`,
  timeColumn: 'written_at',
  syncable: true,
  retention: { tsColumn: 'written_at', kind: 'sensor' },
}

const SCHEMA: AppSchema = { namespace: 'testapp', tables: { app_note: NOTE } }
const TENANT = { brand: 'ziva', familyId: 'fam_A', userId: 'u1' }
const CTX = { brand: 'ziva', tenantScope: 'family' as const, tenantId: 'fam_A', userId: 'u1' }

function rejects(schema: AppSchema, message: RegExp): void {
  let caught: unknown
  try {
    validateAppSchema(schema)
  }
  catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(AnalyticsError)
  expect((caught as AnalyticsError).code).toBe('invalid_config')
  expect((caught as AnalyticsError).message).toMatch(message)
}

describe('validateAppSchema', () => {
  it('accepts a well-formed schema', () => {
    expect(() => validateAppSchema(SCHEMA)).not.toThrow()
  })

  it('rejects a name the package owns', () => {
    rejects({ namespace: 'testapp', tables: { heart_rate: { ...NOTE, ddl: NOTE.ddl.replace('app_note', 'heart_rate') } } }, /package table/)
  })

  it('rejects a v_ name, a bad identifier and a bad namespace', () => {
    rejects({ namespace: 'testapp', tables: { v_note: { ...NOTE, ddl: NOTE.ddl.replace('app_note', 'v_note') } } }, /reserved/)
    rejects({ namespace: 'testapp', tables: { 'Note-1': NOTE } }, /must match/)
    rejects({ namespace: 'Test:App', tables: {} }, /namespace/)
  })

  it('rejects DDL that creates a different table', () => {
    rejects({ namespace: 'testapp', tables: { other: NOTE } }, /must start with "CREATE TABLE other \("/)
  })

  it('rejects a timeColumn or retention column that is not in the DDL', () => {
    rejects({ namespace: 'testapp', tables: { app_note: { ...NOTE, timeColumn: 'ts' } } }, /timeColumn "ts"/)
    rejects({ namespace: 'testapp', tables: { app_note: { ...NOTE, retention: { tsColumn: 'ts', kind: 'sensor' } } } }, /retention.tsColumn "ts"/)
  })

  it('rejects a swept table without the tenant columns, and allows it unswept', () => {
    const noUser = { ...NOTE, ddl: NOTE.ddl.replace('  user_id VARCHAR NOT NULL,\n', '') }
    rejects({ namespace: 'testapp', tables: { app_note: noUser } }, /needs user_id/)
    expect(() => validateAppSchema({ namespace: 'testapp', tables: { app_note: { ...noUser, retention: null } } })).not.toThrow()
  })

  it('rejects migrations that are not numbered 1..n', () => {
    const up = async () => {}
    rejects({ ...SCHEMA, migrations: [{ version: 1, name: 'a', up }, { version: 3, name: 'b', up }] }, /version 3, expected 2/)
  })

  it('createAnalytics refuses an invalid schema before opening anything', () => {
    const { kv } = createFakeKV()
    expect(() => createAnalytics(
      { mode: 'local', storage: kv, retention: {}, appSchema: { namespace: 'testapp', tables: { heart_rate: NOTE } } },
      { duckdbFactory: () => createRealDuckDB([]) },
    )).toThrow(AnalyticsError)
  })
})

async function bootLocal(kv: KVStore, appSchema: AppSchema): Promise<AnalyticsEngine> {
  const analytics = createAnalytics(
    { mode: 'local', storage: kv, retention: {}, appSchema },
    { duckdbFactory: () => createRealDuckDB([]) },
  )
  await new Promise<void>((resolve, reject) => {
    const t = setInterval(() => {
      if (analytics.state === 'ready') {
        clearInterval(t)
        resolve()
      }
      if (analytics.lastError) {
        clearInterval(t)
        reject(analytics.lastError)
      }
    }, 10)
  })
  await analytics.attach(CTX)
  return analytics
}

describe('app tables on attach (real DuckDB)', () => {
  it('creates the table locally with its own key, so a re-write is a no-op', async () => {
    const { kv } = createFakeKV()
    const analytics = await bootLocal(kv, SCHEMA)
    const insert = `INSERT INTO app_note VALUES ('n1', 'ziva', 'fam_A', 'u1', TIMESTAMP '2026-11-01 08:00:00', 'hi')
      ON CONFLICT (note_id) DO NOTHING`
    await analytics.execute(insert)
    await analytics.execute(insert)
    const rows = await analytics.execute('SELECT count(*)::INTEGER AS n FROM app_note') as Array<{ n: number }>
    expect(rows[0]!.n).toBe(1)
  })

  it('runs each app migration once, under its own version key', async () => {
    const { kv, store } = createFakeKV()
    const ran: string[] = []
    const step1 = { version: 1, name: 'add mood', up: async (db: HybridDuckDB, c: { local: string }) => {
      ran.push('1')
      await db.execute(`ALTER TABLE ${c.local}.app_note ADD COLUMN IF NOT EXISTS mood VARCHAR`)
    } }
    await bootLocal(kv, { ...SCHEMA, migrations: [step1] })
    expect(ran).toEqual(['1'])
    expect(store.get(appSchemaVersionKey('testapp', 'ziva', 'fam_A'))).toBe(1)

    // A later release adds step 2; only step 2 runs on the next attach. The
    // next boot is a fresh in-memory database, so forget the PACKAGE version
    // (its tables must be created again) and keep the app's.
    store.delete(schemaVersionKey('ziva', 'fam_A'))
    const step2 = { version: 2, name: 'noop', up: async () => {
      ran.push('2')
    } }
    const again = await bootLocal(kv, { ...SCHEMA, migrations: [step1, step2] })
    expect(ran).toEqual(['1', '2'])
    expect(store.get(appSchemaVersionKey('testapp', 'ziva', 'fam_A'))).toBe(2)
    // Step 1 did not re-run: on this fresh database only its ALTER could
    // have added the column.
    const cols = await again.execute(`SELECT column_name FROM information_schema.columns WHERE table_name = 'app_note'`) as Array<{ column_name: string }>
    expect(cols.map(c => c.column_name)).not.toContain('mood')
  })
})

describe('ensureAppSchema DDL', () => {
  async function ddl(table: AppTable) {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()
    const { kv } = createFakeKV()
    await ensureAppSchema(db, kv, { brand: 'ziva', tenantId: 'fam_A' }, { local: 'zivaone-analytics', remote: 'zone_fam_A' }, {
      namespace: 'testapp',
      tables: { app_note: table },
    })
    return fake.calls.map(c => c.sql).filter(s => s.startsWith('CREATE'))
  }

  it('local without PARTITIONED BY, remote as declared under the Iceberg namespace', async () => {
    const [local, remote] = await ddl(NOTE)
    expect(local).toMatch(/^CREATE TABLE IF NOT EXISTS "zivaone-analytics"\.app_note \(/)
    expect(local).not.toContain('PARTITIONED BY')
    expect(remote).toMatch(/^CREATE TABLE IF NOT EXISTS zone_fam_A\.default\.app_note \(/)
    expect(remote).toContain('PARTITIONED BY (day(written_at))')
  })

  it('a localOnly table is never created remotely', async () => {
    expect(await ddl({ ...NOTE, localOnly: true })).toHaveLength(1)
  })
})

describe('app tables in the retention sweep', () => {
  async function sweep(mode: 'local' | 'r2', appSchema: AppSchema, watermark: Date | null = null) {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()
    const result = await runRetentionSweep(db, 'memory', {
      tenant: TENANT,
      effectiveDays: 90,
      mode,
      appSchema,
      getPushWatermark: async table => (table === 'app_note' ? watermark : null),
    })
    return { result, sql: fake.calls.map(c => c.sql).filter(s => s.includes('app_note')) }
  }

  it('local mode: deletes on the declared column, scoped to the tenant', async () => {
    const { result, sql } = await sweep('local', SCHEMA)
    expect(result.swept).toContainEqual({ table: 'app_note', days: 90 })
    expect(sql).toEqual([
      `DELETE FROM memory.app_note WHERE written_at < now() - INTERVAL '90 days' AND brand = $brand AND family_id = $familyId AND user_id = $userId;`,
    ])
  })

  it('r2 mode: a syncable app table is left alone until something was pushed', async () => {
    const before = await sweep('r2', SCHEMA)
    expect(before.result.skipped).toContain('app_note')
    expect(before.sql).toEqual([])

    const after = await sweep('r2', SCHEMA, new Date('2026-11-01T00:00:00Z'))
    expect(after.sql[0]).toContain('LEAST(now() - INTERVAL \'90 days\', CAST($pushWatermark AS TIMESTAMP))')
  })

  it('a table declared with retention null is never swept', async () => {
    const { sql } = await sweep('local', { namespace: 'testapp', tables: { app_note: { ...NOTE, retention: null } } })
    expect(sql).toEqual([])
  })
})

describe('app tables in push / fetch', () => {
  it('timeColumnFor / isSyncable resolve app tables, package tables win', () => {
    expect(timeColumnFor('app_note')).toBe('ts')
    expect(timeColumnFor('app_note', SCHEMA)).toBe('written_at')
    expect(isSyncable('app_note')).toBe(false)
    expect(isSyncable('app_note', SCHEMA)).toBe(true)
    expect(timeColumnFor('sleep_session', SCHEMA)).toBe('ts_start')
  })

  function watermark() {
    const { kv } = createFakeKV()
    return new WatermarkStore({ kv, now: () => new Date('2026-11-13T00:00:00Z'), defaultRetentionMs: 86_400_000 })
  }

  it('the pusher bounds an app table on its declared column', async () => {
    const fake = createFakeSqlEngine()
    const pusher = new R2Pusher({ engine: fake.engine, watermark: watermark(), appSchema: SCHEMA })
    await pusher.push('app_note', CTX)
    expect(fake.calls[0]!.sql).toContain('SELECT MAX(written_at)')
  })

  it('the fetcher bounds on the declared column and is idempotent on the app key', async () => {
    const fake = createFakeSqlEngine()
    const fetcher = new R2Fetcher({ engine: fake.engine, watermark: watermark(), tables: ['app_note'], appSchema: SCHEMA })
    await fetcher.fetchIncremental(CTX)
    expect(fake.calls[0]!.sql).toContain('WHERE written_at > $watermark')
    expect(fake.calls[0]!.sql).toMatch(/ON CONFLICT DO NOTHING$/)
  })
})
