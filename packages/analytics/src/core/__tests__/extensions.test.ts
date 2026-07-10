import { describe, expect, it } from 'vitest'

import { HybridDuckDB } from '../engine'
import {
  bootstrapExtensions,
  getBootedExtensions,
  REQUIRED_EXTENSIONS,
} from '../extensions'

import { createFakeDuckDB } from './__fakes__/fake-duckdb'

async function newOpenDb() {
  const fake = createFakeDuckDB()
  const db = new HybridDuckDB(fake.factory)
  await db.open()
  return { fake, db }
}

describe('bootstrapExtensions', () => {
  it('issues INSTALL + LOAD for httpfs, iceberg, parquet in order', async () => {
    const { fake, db } = await newOpenDb()

    await bootstrapExtensions(db)

    expect(fake.calls.map(c => c.sql)).toEqual([
      'INSTALL httpfs;',
      'LOAD httpfs;',
      'INSTALL iceberg;',
      'LOAD iceberg;',
      'INSTALL parquet;',
      'LOAD parquet;',
    ])
  })

  it('maps native failure to AnalyticsError(extension_load_failed) with extension name', async () => {
    const { fake, db } = await newOpenDb()

    // First two INSTALLs (httpfs) succeed; then LOAD httpfs fails.
    // Fake queues one failure onto the *next* execute.
    let calls = 0
    const originalExecute = fake.instance.execute
    fake.instance.execute = async (sql, params) => {
      calls += 1
      if (calls === 2) {
        // The 2nd call is `LOAD httpfs;`
        throw new Error('cannot find shared lib')
      }
      return originalExecute.call(fake.instance, sql, params)
    }

    await expect(bootstrapExtensions(db)).rejects.toMatchObject({
      code: 'extension_load_failed',
      message: expect.stringContaining('httpfs'),
    })
  })

  it('is idempotent — second call is a no-op', async () => {
    const { fake, db } = await newOpenDb()

    await bootstrapExtensions(db)
    const firstCount = fake.calls.length
    await bootstrapExtensions(db)

    expect(fake.calls.length).toBe(firstCount)
    expect(getBootedExtensions(db).size).toBe(REQUIRED_EXTENSIONS.length)
  })

  it('records all three extensions in the booted set', async () => {
    const { db } = await newOpenDb()

    await bootstrapExtensions(db)

    const booted = getBootedExtensions(db)
    for (const ext of REQUIRED_EXTENSIONS) {
      expect(booted.has(ext)).toBe(true)
    }
  })
})
