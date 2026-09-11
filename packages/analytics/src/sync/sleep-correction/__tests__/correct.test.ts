/**
 * The Phase 2 SQL and the per-night orchestration on a real DuckDB, with a
 * synthetic night — so CI exercises the port without the private captures
 * the parity suite needs.
 *
 * The night: firmware light sleep 23:00–01:00 and 01:30–04:00 (UTC, tz 0),
 * HR at 60 bpm every 5 min from 22:00 to 06:00. Expected, from v3.1's rules:
 * the 01:00–01:30 hole is filled from HR (envelope/gap), the night extends
 * from the last firmware minute (04:00) toward 06:00 on sleeping-level HR,
 * everything stitches into one block, and that block is primary.
 */
import type { SqlRunner } from '../correct'

import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../../__integration__/setup/real-engine'
import { computeNightEpochs, parseDateStr } from '../classify'
import { correctNight, detectHrTier, globalBaselines } from '../correct'
import { correctNightSql, detectHrTierSql } from '../sql'

const at = (iso: string) => Date.parse(`${iso}Z`) / 1000

async function nightDb(): Promise<SqlRunner & { close?: () => Promise<void> }> {
  const db = await createRealDuckDB([])
  await db.execute(`CREATE TABLE stg_sleep (date BIGINT, quality INT, start BIGINT, "unitLength" INT)`)
  await db.execute(`CREATE TABLE stg_heartrate (date BIGINT, "singleHR" DOUBLE)`)
  await db.execute(`CREATE TABLE stg_activity (date BIGINT, step DOUBLE)`)

  const sleep: string[] = []
  const session = (from: string, minutes: number) => {
    const s = at(from)
    for (let i = 0; i <= minutes; i++) sleep.push(`(${s + i * 60}, 2, ${s}, 1)`)
  }
  session('2026-06-17T23:00:00', 120) // 23:00–01:00
  session('2026-06-18T01:30:00', 150) // 01:30–04:00
  await db.execute(`INSERT INTO stg_sleep VALUES ${sleep.join(',')}`)

  const hr: string[] = []
  for (let t = at('2026-06-17T22:00:00'); t <= at('2026-06-18T06:00:00'); t += 300)
    hr.push(`(${t}, 60)`)
  await db.execute(`INSERT INTO stg_heartrate VALUES ${hr.join(',')}`)
  return db
}

describe('sleep correction on DuckDB', () => {
  it('corrects a night: fills the hole, extends on sleeping HR, one primary block', async () => {
    const db = await nightDb()
    const { windowStart, windowEnd } = computeNightEpochs('2026-06-18', 0)
    const res = await correctNight(db, { windowStart, windowEnd, hrIntervalMin: 5, p75: 80, p90: 90, tzOffsetHours: 0 })
    await db.close?.()

    expect(res.status).toBe('ok')
    if (res.status !== 'ok')
      return
    const { rows } = res
    // UTC formatting. to_timestamp() would render in the session zone and
    // corrupt Phase 3's parse; make_timestamp is naive UTC.
    expect(rows[0].date).toBe('2026.06.17 23:00:00')
    expect(rows[rows.length - 1].date).toBe('2026.06.18 06:00:00')
    expect(new Set(rows.map(r => r.block_type))).toEqual(new Set(['primary']))

    const sources = new Set(rows.map(r => r.source))
    expect(sources.has('firmware')).toBe(true)
    expect([...sources].every(s => ['firmware', 'envelope', 'gap'].includes(s))).toBe(true)
    // The 01:00–01:30 hole is filled.
    const hole = rows.filter(r => parseDateStr(r.date) > at('2026-06-18T01:00:00') && parseDateStr(r.date) < at('2026-06-18T01:30:00'))
    expect(hole.length).toBeGreaterThan(0)
    expect(hole.every(r => r.source !== 'firmware')).toBe(true)
  }, 60_000)

  it('skips a night with no firmware sleep', async () => {
    const db = await nightDb()
    const { windowStart, windowEnd } = computeNightEpochs('2026-06-25', 0)
    const res = await correctNight(db, { windowStart, windowEnd, hrIntervalMin: 5, p75: 80, p90: 90, tzOffsetHours: 0 })
    await db.close?.()
    expect(res.status).toBe('no_firmware_sleep')
  }, 60_000)

  it('derives the HR tier and sleeping-HR percentiles from the data', async () => {
    const db = await nightDb()
    expect(await detectHrTier(db)).toBe(5) // 300 s cadence ⇒ 5-min tier
    expect(await globalBaselines(db, 0)).toEqual({ p75: 60, p90: 60 })
    // Nothing since the cutoff ⇒ v3.1's COALESCE to HR_MAX.
    expect(await globalBaselines(db, at('2027-01-01T00:00:00'))).toEqual({ p75: 120, p90: 120 })
    await db.close?.()
  }, 60_000)

  it('refuses non-finite numbers and unsafe relation names in the SQL', () => {
    expect(() => correctNightSql(Number.NaN, 0, 5, 80, 90)).toThrow('non-finite')
    expect(() => detectHrTierSql({ sleep: 's', heartrate: 'x; DROP TABLE y', activity: 'a' })).toThrow('invalid relation')
  })
})
