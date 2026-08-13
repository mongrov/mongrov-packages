import { describe, expect, it } from 'vitest'

import { HybridDuckDB } from '../engine'
import {
  bootstrapExtensions,
  getBootedExtensions,
  LOCAL_EXTENSIONS,
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
  it('LOADs in the order httpfs → icu → iceberg → parquet, without INSTALL', async () => {
    const { fake, db } = await newOpenDb()

    await bootstrapExtensions(db)

    // Order is load-bearing (Sprint 5 T-01): icu after httpfs, before iceberg.
    // No INSTALL when LOAD succeeds — a statically linked extension needs
    // none, and on mobile the fetch 404s.
    expect(fake.calls.map(c => c.sql)).toEqual([
      'LOAD httpfs;',
      'LOAD icu;',
      'LOAD iceberg;',
      'LOAD parquet;',
    ])
  })

  it('falls back to INSTALL when LOAD fails, for builds that must fetch', async () => {
    const { fake, db } = await newOpenDb()

    const original = fake.instance.execute
    let failedOnce = false
    fake.instance.execute = async (sql, params) => {
      if (!failedOnce && sql === 'LOAD icu;') {
        failedOnce = true
        throw new Error('not linked in')
      }
      return original.call(fake.instance, sql, params)
    }

    await bootstrapExtensions(db, 'local')

    // The failed `LOAD icu;` is absent because the stub throws before
    // delegating, and the fake only records calls that reach the instance.
    // What matters is that INSTALL follows the failure and the retry LOAD
    // then succeeds.
    expect(fake.calls.map(c => c.sql)).toEqual([
      'INSTALL icu;', // fallback, after LOAD threw
      'LOAD icu;', // retry succeeds
      'LOAD parquet;',
    ])
    expect(failedOnce).toBe(true)
  })

  it('loads icu in local mode too — timezone() is not an R2-only concern', async () => {
    const { fake, db } = await newOpenDb()

    await bootstrapExtensions(db, 'local')

    // Local mode skips httpfs + iceberg (no AWSSDK/vcpkg build burden) but
    // must keep icu: day-grouped charts and day-first baselines call
    // timezone($tz, ts), which needs it.
    expect(fake.calls.map(c => c.sql)).toEqual([
      'LOAD icu;',
      'LOAD parquet;',
    ])
    expect(LOCAL_EXTENSIONS).toContain('icu')
  })

  it('maps native failure to AnalyticsError(extension_load_failed) with extension name', async () => {
    const { fake, db } = await newOpenDb()

    // Every attempt for httpfs fails — LOAD, then the INSTALL fallback, then
    // the retry LOAD — which is the genuinely-broken case.
    const originalExecute = fake.instance.execute
    fake.instance.execute = async (sql, params) => {
      if (sql.includes('httpfs')) {
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

  it('records every required extension in the booted set', async () => {
    const { db } = await newOpenDb()

    await bootstrapExtensions(db)

    const booted = getBootedExtensions(db)
    for (const ext of REQUIRED_EXTENSIONS) {
      expect(booted.has(ext)).toBe(true)
    }
  })
})
