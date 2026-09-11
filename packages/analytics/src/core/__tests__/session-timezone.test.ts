/**
 * Every window is `ts > NOW() - INTERVAL …` over a naive-UTC `ts`.
 *
 * With icu loaded, DuckDB reads that naive value in the SESSION zone to
 * compare it with `NOW()`, and on a device the session zone is the device's.
 * So a reading taken 20h ago in India was treated as 25.5h old and fell out
 * of a 24h window. `bootstrapExtensions` pins the session to UTC; this suite
 * is the guard, on a real engine, starting from an Indian session the way a
 * device would.
 */
import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { HybridDuckDB } from '../engine'
import { bootstrapExtensions } from '../extensions'

/** A naive-UTC timestamp `hours` ago — how every metric table stores `ts`. */
function naiveUtcHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')
}

/** An engine whose session is Asia/Kolkata, as on a device in India. */
async function indianSession(): Promise<HybridDuckDB> {
  const db = new HybridDuckDB(() => createRealDuckDB(['icu']))
  await db.open()
  await db.execute(`SET TimeZone='Asia/Kolkata';`)
  return db
}

async function insideLast24h(db: HybridDuckDB, hoursAgo: number): Promise<boolean> {
  const rows = await db.execute<{ inside: boolean }>(
    `SELECT CAST($ts AS TIMESTAMP) > NOW() - INTERVAL '24 hours' AS inside`,
    { ts: naiveUtcHoursAgo(hoursAgo) },
  )
  return rows[0]!.inside
}

describe('session time zone', () => {
  it('control: an unpinned Indian session drops a 20h-old reading from a 24h window', async () => {
    // Without this, the case below passes on an engine where the defect never
    // existed. 20h + 5.5h offset = 25.5h, outside the window.
    const db = await indianSession()
    expect(await insideLast24h(db, 20)).toBe(false)
    await db.close()
  }, 60_000)

  it('bootstrapExtensions pins the session to UTC, so the window is 24 real hours', async () => {
    const db = await indianSession()
    await bootstrapExtensions(db, 'local')

    const [{ tz }] = await db.execute<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`)
    expect(tz).toBe('UTC')
    expect(await insideLast24h(db, 20)).toBe(true)
    // And the far edge still excludes: this is a 24h window, not an unbounded one.
    expect(await insideLast24h(db, 26)).toBe(false)
    await db.close()
  }, 60_000)
})
