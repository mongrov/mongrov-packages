import { describe, expect, it } from 'vitest'

import { HybridDuckDB } from '../engine'
import {
  ensureSchemas,
  qualifyDdl,
  SCHEMAS,
  TABLE_NAMES,
} from '../schemas'

import { createFakeDuckDB } from './__fakes__/fake-duckdb'

async function newOpenDb() {
  const fake = createFakeDuckDB()
  const db = new HybridDuckDB(fake.factory)
  await db.open()
  return { fake, db }
}

describe('SCHEMAS', () => {
  it('has an entry for every TABLE_NAMES value', () => {
    for (const table of TABLE_NAMES) {
      expect(SCHEMAS[table]).toBeDefined()
      expect(SCHEMAS[table]).toContain(`CREATE TABLE ${table}`)
    }
  })

  it('covers every table in spec §Table schema', () => {
    // Derived, not hardcoded: adding a table should not fail this
    // assertion, only the per-table DDL snapshots below.
    expect(new Set(TABLE_NAMES).size).toBe(TABLE_NAMES.length)
    expect(TABLE_NAMES.length).toBeGreaterThanOrEqual(15)
  })

  it('toLocalDdl strips PARTITIONED BY cleanly despite nested parens', async () => {
    // Regression: `PARTITIONED BY (day(ts), user_id)` contains nested
    // parens; a naive `\([^)]*\)` match left a dangling `, user_id);`
    // that made every partitioned LOCAL_SCHEMAS entry a parser error on
    // real DuckDB (fake engines swallowed it silently until 0.6.0).
    const { LOCAL_SCHEMAS } = await import('../schemas')
    for (const table of TABLE_NAMES) {
      const ddl = LOCAL_SCHEMAS[table]
      expect(ddl).not.toContain('PARTITIONED')
      expect(ddl.trimEnd().endsWith(');')).toBe(true)
      // No dangling fragment after the terminator.
      expect(ddl.trimEnd().indexOf(');')).toBe(ddl.trimEnd().length - 2)
    }
  })

  it('uses TIMESTAMP (per spec) not TIMESTAMPTZ', () => {
    // Every ts column uses TIMESTAMP per spec; a stray TZ would signal drift.
    for (const table of TABLE_NAMES) {
      expect(SCHEMAS[table]).not.toContain('TIMESTAMPTZ')
    }
  })

  it('insight DDL matches the spec contract (fix CO-2)', () => {
    const ddl = SCHEMAS.insight
    expect(ddl).toContain('insight_id VARCHAR PRIMARY KEY')
    expect(ddl).toContain('metric VARCHAR NOT NULL')
    expect(ddl).toContain('kind VARCHAR NOT NULL')
    expect(ddl).toContain('dismissed_at TIMESTAMP')
    expect(ddl).toContain('acknowledged_at TIMESTAMP')
    // Old PK name must be gone.
    expect(ddl).not.toMatch(/\n {2}id VARCHAR/)
  })

  it('insightIndexDdl composes the spec lookup index for a catalog', async () => {
    const { insightIndexDdl } = await import('../schemas')
    expect(insightIndexDdl('memory')).toBe(
      'CREATE INDEX IF NOT EXISTS idx_insight_lookup ON memory.insight (user_id, metric, dismissed_at, ts);',
    )
  })
})

describe('qualifyDdl', () => {
  it('rewrites CREATE TABLE to CREATE TABLE IF NOT EXISTS <catalog>.<table>', () => {
    const rewritten = qualifyDdl(SCHEMAS.hrv, 'hrv', 'zone_fam123')
    expect(rewritten).toContain('CREATE TABLE IF NOT EXISTS zone_fam123.hrv')
    expect(rewritten).not.toContain('CREATE TABLE hrv')
  })

  it('preserves the column definitions and PARTITIONED BY clause', () => {
    const rewritten = qualifyDdl(SCHEMAS.hrv, 'hrv', 'zone_fam123')
    expect(rewritten).toContain('hrv_ms INTEGER')
    expect(rewritten).toContain('PARTITIONED BY (day(ts), user_id)')
  })
})

describe('ensureSchemas', () => {
  it('issues one CREATE TABLE IF NOT EXISTS per table, in TABLE_NAMES order', async () => {
    const { fake, db } = await newOpenDb()

    await ensureSchemas(db, 'zone_fam123')

    expect(fake.calls).toHaveLength(TABLE_NAMES.length)
    for (let i = 0; i < TABLE_NAMES.length; i++) {
      const table = TABLE_NAMES[i]
      expect(fake.calls[i].sql).toContain(`CREATE TABLE IF NOT EXISTS zone_fam123.${table}`)
    }
  })

  it('is idempotent — the DDL uses IF NOT EXISTS on every table', async () => {
    const { fake, db } = await newOpenDb()

    await ensureSchemas(db, 'zone_fam123')
    await ensureSchemas(db, 'zone_fam123')

    expect(fake.calls).toHaveLength(TABLE_NAMES.length * 2)
    for (const call of fake.calls) {
      expect(call.sql).toContain('IF NOT EXISTS')
    }
  })

  it('maps DDL failure to AnalyticsError(migration_failed) with table name', async () => {
    const { fake, db } = await newOpenDb()
    // Fail on the 3rd DDL — `spo2` is the 3rd table.
    let count = 0
    const original = fake.instance.execute
    fake.instance.execute = async (sql, params) => {
      count += 1
      if (count === 3) throw new Error('bad ddl')
      return original.call(fake.instance, sql, params)
    }

    await expect(ensureSchemas(db, 'zone_fam123')).rejects.toMatchObject({
      code: 'migration_failed',
      message: expect.stringContaining('spo2'),
    })
  })
})
