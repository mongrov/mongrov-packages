/**
 * Catalog probe fallback.
 *
 * `SELECT current_database()` works on desktop DuckDB but the
 * react-native-duckdb iOS build rejects it with
 * `Binder Error: Referenced table "system" not found!`, which took attach
 * down before any table was touched. The probe must survive that.
 */
import { describe, expect, it } from 'vitest'

import { probeLocalCatalog } from '../warehouse'

function dbWith(handler: (sql: string) => unknown[]) {
  const calls: string[] = []
  return {
    calls,
    db: {
      async execute(sql: string) {
        calls.push(sql)
        return handler(sql)
      },
    } as never,
  }
}

describe('probeLocalCatalog', () => {
  it('uses current_database() when it works', async () => {
    const { db, calls } = dbWith(() => [{ current_database: 'zivaone' }])
    expect(await probeLocalCatalog(db)).toBe('zivaone')
    expect(calls).toHaveLength(1)
  })

  it('falls back to PRAGMA database_list when the binder rejects the function', async () => {
    const { db, calls } = dbWith((sql) => {
      if (sql.includes('current_database')) {
        throw new Error('Binder Error: Referenced table "system" not found!')
      }
      return [{ name: 'temp' }, { name: 'zivaone_analytics' }]
    })

    expect(await probeLocalCatalog(db)).toBe('zivaone_analytics')
    expect(calls[1]).toContain('database_list')
  })

  it('skips the temp catalog', async () => {
    const { db } = dbWith((sql) => {
      if (sql.includes('current_database'))
        throw new Error('nope')
      return [{ name: 'temp' }, { name: 'main_db' }]
    })
    expect(await probeLocalCatalog(db)).toBe('main_db')
  })

  it('surfaces the failure when every probe fails', async () => {
    const { db } = dbWith(() => { throw new Error('all broken') })
    await expect(probeLocalCatalog(db)).rejects.toMatchObject({
      code: 'query_failed',
    })
  })
})
