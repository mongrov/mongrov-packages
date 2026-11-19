/**
 * The `sleep_total_minutes` baseline, run through real DuckDB with EXACTLY
 * the params the baseline runner binds (`computeDefinition`: userId, brand,
 * familyId, tz, windowDays) — no filtering (zivaone_app#673).
 *
 * Its SQL used to reference no `$tz`, and DuckDB rejects a bound name the
 * statement does not declare ("Failed to retrieve bind parameter index"), so
 * it failed on every engine that binds what it is given. The app's device
 * factory drops unreferenced params (`bindableParams`), which is why phones
 * still computed it; every desktop harness did not.
 */

import { formatInTimeZone } from 'date-fns-tz'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRealDuckDB } from '../../../../__integration__/setup/real-engine'
import { generateViewDdl } from '../../../../core/schemas'
import { buildBaselineSql } from '../../health/baselines'
import { LOCAL_SCHEMAS } from '../../legacy-tables'

const TZ = 'Asia/Kolkata'
const T = { brand: 'ziva', familyId: 'fam_1', userId: 'u1' }
const DAY = 86_400_000

/** Local calendar date `k` days before today in TZ, as YYYY-MM-DD. */
function localDate(k: number): string {
  const today = formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd')
  return new Date(Date.parse(`${today}T00:00:00Z`) - k * DAY).toISOString().slice(0, 10)
}

/** Nightly totals by night index (1 = last night). Night 0 is tonight, partial. */
const minutesOf = (k: number) => (k === 0 ? 30 : 400 + 3 * k)

/** quantile_cont, as DuckDB computes it. */
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

let db: Awaited<ReturnType<typeof createRealDuckDB>>

beforeAll(async () => {
  db = await createRealDuckDB(['icu'])
  await db.execute(LOCAL_SCHEMAS.sleep_session.replace('CREATE TABLE sleep_session', 'CREATE TABLE memory.sleep_session'))
  await db.execute(generateViewDdl('sleep_session', { brand: T.brand, familyId: T.familyId, localCatalog: 'memory' }))
  const rows: string[] = []
  for (let k = 0; k <= 100; k++) {
    const night = localDate(k)
    // 22:00 local on the night's evening (16:30 UTC in Kolkata). Tonight's
    // session starts an hour ago, so it exists whatever time the test runs.
    const start = k === 0 ? new Date(Date.now() - 3_600_000) : new Date(Date.parse(`${night}T16:30:00Z`))
    const end = new Date(start.getTime() + minutesOf(k) * 60_000)
    const iso = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '')
    rows.push(`('s${k}', TIMESTAMP '${iso(start)}', TIMESTAMP '${iso(end)}', 'ziva', 'fam_1', 'u1', 'ring_1', ${minutesOf(k)}, DATE '${night}')`)
    // A second session on one night: the daily value is the night's SUM.
    if (k === 5)
      rows.push(`('s5b', TIMESTAMP '${iso(new Date(end.getTime() + 600_000))}', TIMESTAMP '${iso(new Date(end.getTime() + 1_800_000))}', 'ziva', 'fam_1', 'u1', 'ring_1', 20, DATE '${night}')`)
  }
  await db.execute(`INSERT INTO memory.sleep_session (session_id, ts_start, ts_end, brand, family_id, user_id, device_id, total_minutes, night_of) VALUES ${rows.join(',')}`)
})

afterAll(async () => {
  await db.close()
})

describe('sleep_total_minutes baseline SQL, with the runner\'s exact params', () => {
  it.each([7, 30, 90] as const)('%id: binds, and reads the N most recent complete local nights', async (windowDays) => {
    const sql = buildBaselineSql('sleep_total_minutes', windowDays)
    const rows = await db.execute<Record<string, number | bigint>>(sql, { ...T, tz: TZ, windowDays })
    const nights = Array.from({ length: windowDays }, (_, i) => minutesOf(i + 1) + (i + 1 === 5 ? 20 : 0)).sort((a, b) => a - b)
    if (windowDays === 7) {
      // Below BASELINE_MIN_DAYS: the quantile pass's HAVING returns nothing.
      expect(rows).toEqual([])
      return
    }
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(Number(r.sample_count)).toBe(windowDays)
    expect(Number(r.p50)).toBeCloseTo(quantile(nights, 0.5), 6)
    expect(Number(r.p05)).toBeCloseTo(quantile(nights, 0.05), 6)
    expect(Number(r.mean)).toBeCloseTo(nights.reduce((a, b) => a + b, 0) / nights.length, 6)
  })

  it('every placeholder the SQL declares is one the runner binds, and it declares $tz', () => {
    const declared = new Set(Array.from(buildBaselineSql('sleep_total_minutes', 30).matchAll(/\$([a-z]\w*)/gi), m => m[1]))
    expect([...declared].sort()).toEqual(['brand', 'familyId', 'tz', 'userId', 'windowDays'])
  })
})
