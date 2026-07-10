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

  it('covers 14 tables per spec §Table schema', () => {
    expect(TABLE_NAMES).toHaveLength(14)
  })

  it('uses TIMESTAMP (per spec) not TIMESTAMPTZ', () => {
    // Every ts column uses TIMESTAMP per spec; a stray TZ would signal drift.
    for (const table of TABLE_NAMES) {
      expect(SCHEMAS[table]).not.toContain('TIMESTAMPTZ')
    }
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
    expect(rewritten).toContain('hrv_ms SMALLINT')
    expect(rewritten).toContain('PARTITIONED BY (day(ts), user_id)')
  })
})

describe('ensureSchemas', () => {
  it('issues 14 CREATE TABLE IF NOT EXISTS statements in TABLE_NAMES order', async () => {
    const { fake, db } = await newOpenDb()

    await ensureSchemas(db, 'zone_fam123')

    expect(fake.calls).toHaveLength(14)
    for (let i = 0; i < TABLE_NAMES.length; i++) {
      const table = TABLE_NAMES[i]
      expect(fake.calls[i].sql).toContain(`CREATE TABLE IF NOT EXISTS zone_fam123.${table}`)
    }
  })

  it('is idempotent — the DDL uses IF NOT EXISTS on every table', async () => {
    const { fake, db } = await newOpenDb()

    await ensureSchemas(db, 'zone_fam123')
    await ensureSchemas(db, 'zone_fam123')

    expect(fake.calls).toHaveLength(28)
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
