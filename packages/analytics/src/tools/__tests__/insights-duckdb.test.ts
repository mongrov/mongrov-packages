/**
 * `getInsights` against real DuckDB and the real `insight` DDL (principle 62).
 *
 * Insight times are stored naive UTC. The tool printed them as UTC with no
 * zone marker; it now prints the user's local wall-clock time in the same
 * `YYYY-MM-DD HH:MM:SS` form, converted in the query (principle 67). Its
 * window also binds `days` as a parameter, never as SQL text.
 */

import type { DuckDBConnection } from '@duckdb/node-api'
import type { AnalyticsEngine } from '../../core/types'
import { DuckDBInstance } from '@duckdb/node-api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toLocalDdl } from '../../core/ddl'
import { PLATFORM_SCHEMAS } from '../../core/platform-tables'
import { getInsights } from '../impls/insights'

let conn: DuckDBConnection
const sqls: string[] = []

const engine = {
  async execute<T>(sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
    sqls.push(sql)
    const reader = await conn.runAndReadAll(sql, params as never)
    return reader.getRowObjectsJS() as T[]
  },
} as unknown as AnalyticsEngine

beforeAll(async () => {
  const db = await DuckDBInstance.create(':memory:')
  conn = await db.connect()
  await conn.run('LOAD icu')
  await conn.run(toLocalDdl(PLATFORM_SCHEMAS.insight))
  // One notice two hours ago (UTC, naive), one dismissed, one 40 days ago.
  await conn.run(`
    INSERT INTO insight (insight_id, ts, brand, family_id, user_id, metric, kind, severity, title, body, dismissed_at)
    VALUES
      ('a', CAST(timezone('UTC', now()) AS TIMESTAMP) - INTERVAL 2 HOUR, 'acme', 'fam-1', 'alice', 'm', 'k', 'warn', 'Recent', 'body', NULL),
      ('b', CAST(timezone('UTC', now()) AS TIMESTAMP) - INTERVAL 3 HOUR, 'acme', 'fam-1', 'alice', 'm', 'k', 'info', 'Dismissed', NULL, now()),
      ('c', CAST(timezone('UTC', now()) AS TIMESTAMP) - INTERVAL 40 DAY, 'acme', 'fam-1', 'alice', 'm', 'k', 'info', 'Old', NULL, NULL)
  `)
})

afterAll(() => conn?.closeSync())

function ctx(timezone?: string) {
  return {
    requesterUserId: 'alice',
    brand: 'acme',
    familyId: 'fam-1',
    timezone,
    analytics: engine,
  }
}

async function storedUtc(): Promise<string> {
  const r = await conn.runAndReadAll(`SELECT CAST(ts AS VARCHAR) AS ts FROM insight WHERE insight_id = 'a'`)
  return (r.getRowObjectsJS()[0] as { ts: string }).ts
}

describe('getInsights on DuckDB', () => {
  it('prints the time in the user\'s zone (Asia/Kolkata is UTC+05:30)', async () => {
    const utc = await storedUtc()
    const local = new Date(`${utc.replace(' ', 'T')}Z`).getTime() + 330 * 60_000
    const expected = new Date(local).toISOString().replace('T', ' ').slice(0, 19)

    const res = await getInsights({ userId: 'alice', days: 7 }, ctx('Asia/Kolkata'))
    expect(res.text.split('\n')).toEqual([
      'Insights, last 7 days:',
      `  [warn] ${expected.slice(0, 19)}${utc.length > 19 ? utc.slice(19) : ''}: Recent — body`,
    ])
  })

  it('prints UTC when no zone is set, exactly as stored', async () => {
    const res = await getInsights({ userId: 'alice', days: 7 }, ctx())
    expect(res.text).toContain(`[warn] ${await storedUtc()}: Recent`)
  })

  it('binds days as a parameter, and leaves out dismissed and out-of-window notices', async () => {
    sqls.length = 0
    const week = await getInsights({ userId: 'alice', days: 7 }, ctx('UTC'))
    expect(week.rowCount).toBe(1)
    const month = await getInsights({ userId: 'alice', days: 30 }, ctx('UTC'))
    expect(month.rowCount).toBe(1)
    expect(sqls.every(s => !/INTERVAL\s*(?:\(\s*)?\d/.test(s))).toBe(true)
    expect(sqls.every(s => s.includes('$days'))).toBe(true)
  })
})
