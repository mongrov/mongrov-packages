import { describe, expect, it } from 'vitest'

import { AnalyticsError } from '../errors'
import { HybridDuckDB } from '../engine'

import { createFakeDuckDB } from './__fakes__/fake-duckdb'

describe('HybridDuckDB', () => {
  it('open() calls the factory once and is idempotent', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)

    await db.open()
    await db.open()
    await db.open()

    expect(fake.factoryCount).toBe(1)
    expect(db.isOpen).toBe(true)
  })

  it('open() failure surfaces as AnalyticsError(engine_open_failed)', async () => {
    const cause = new Error('native boom')
    const fake = createFakeDuckDB({ failOnOpen: cause })
    const db = new HybridDuckDB(fake.factory)

    await expect(db.open()).rejects.toMatchObject({
      code: 'engine_open_failed',
      cause,
    })
    expect(db.isOpen).toBe(false)
  })

  it('execute() forwards SQL + params and returns rows', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()

    fake.setNextExecuteRows([{ n: 1 }, { n: 2 }])
    const rows = await db.execute<{ n: number }>('SELECT n FROM t WHERE k = $k', { k: 42 })

    expect(rows).toEqual([{ n: 1 }, { n: 2 }])
    expect(fake.calls).toEqual([
      { sql: 'SELECT n FROM t WHERE k = $k', params: { k: 42 } },
    ])
  })

  it('execute() maps native errors to AnalyticsError(query_failed)', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()

    const cause = new Error('syntax error')
    fake.failNextExecute(cause)

    await expect(db.execute('SELECT 1')).rejects.toMatchObject({
      code: 'query_failed',
      cause,
    })
  })

  it('execute() before open() throws not_ready', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)

    await expect(db.execute('SELECT 1')).rejects.toMatchObject({
      code: 'not_ready',
    })
  })

  it('stream() yields rows across pages', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()

    fake.setNextStreamPages([
      [{ n: 1 }, { n: 2 }],
      [{ n: 3 }],
    ])

    const collected: { n: number }[][] = []
    for await (const page of db.stream<{ n: number }>('SELECT n FROM t')) {
      collected.push(page)
    }

    expect(collected).toEqual([
      [{ n: 1 }, { n: 2 }],
      [{ n: 3 }],
    ])
  })

  it('createAppender() returns an appender that captures batched rows and flush()', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()

    const appender = db.createAppender('hrv')
    appender.appendRow(['device-1', 1000, 50])
    appender.appendRow(['device-1', 2000, 55])
    appender.appendRow(['device-1', 3000, 60])
    appender.flush()

    expect(fake.appenders).toHaveLength(1)
    const [record] = fake.appenders
    expect(record.table).toBe('hrv')
    expect(record.rows).toEqual([
      ['device-1', 1000, 50],
      ['device-1', 2000, 55],
      ['device-1', 3000, 60],
    ])
    expect(record.flushed).toBe(1)
  })

  it('close() releases the connection and subsequent execute() throws not_ready', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()

    await db.close()
    await db.close() // idempotent

    expect(fake.closeCount).toBe(1)
    expect(db.isOpen).toBe(false)
    await expect(db.execute('SELECT 1')).rejects.toMatchObject({ code: 'not_ready' })
  })

  it('PAGE_SIZE is exposed as spec-defined constant', () => {
    expect(HybridDuckDB.PAGE_SIZE).toBe(500)
  })

  it('wraps AnalyticsError from execute() with cause chain intact', async () => {
    const fake = createFakeDuckDB()
    const db = new HybridDuckDB(fake.factory)
    await db.open()

    fake.failNextExecute('bad')
    try {
      await db.execute('SELECT 1')
      expect.fail('should have thrown')
    }
    catch (err) {
      expect(err).toBeInstanceOf(AnalyticsError)
      expect((err as AnalyticsError).code).toBe('query_failed')
    }
  })
})
