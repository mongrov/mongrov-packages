/**
 * Migration portability on the iOS DuckDB build.
 *
 * Two things that work on desktop DuckDB and do not there:
 *   - `information_schema.columns` lives in the `system` catalog, which the
 *     react-native-duckdb build cannot resolve ("Referenced table 'system'
 *     not found!").
 *   - a catalog name from the db filename (`acme-analytics`) is not a
 *     valid bare identifier.
 *
 * Both took attach down after the previous fix unblocked the step before.
 */
import { describe, expect, it } from 'vitest'

import { ensureMigrations } from '../migrations'

function scriptedDb(onSql: (sql: string) => unknown[]) {
  const sqls: string[] = []
  return {
    sqls,
    db: {
      async execute(sql: string) {
        sqls.push(sql)
        return onSql(sql)
      },
    } as never,
  }
}

function kv() {
  const store = new Map<string, string>()
  return {
    async get(k: string) { return store.get(k) ?? null },
    async set(k: string, v: string) { store.set(k, v) },
    async delete(k: string) { store.delete(k) },
  } as never
}

const CTX = { brand: 'acme', tenantId: 'fam_1' }

describe('migrations against a hyphenated catalog', () => {
  it('never emits an unquoted hyphenated catalog', async () => {
    const { db, sqls } = scriptedDb(() => [])

    await ensureMigrations(db, kv(), CTX, { local: 'acme-analytics' })

    const offenders = sqls.filter(s => /[^"]acme-analytics[^"]/.test(s))
    expect(offenders).toEqual([])
    expect(sqls.some(s => s.includes('"acme-analytics"'))).toBe(true)
  })

  it('probes columns without touching information_schema', async () => {
    const { db, sqls } = scriptedDb(() => [])

    await ensureMigrations(db, kv(), CTX, { local: 'acme-analytics' })

    expect(sqls.some(s => s.includes('information_schema'))).toBe(false)
    expect(sqls.some(s => s.includes('PRAGMA table_info'))).toBe(true)
  })
})
