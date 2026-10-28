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
import { correctNight, detectHrTier, detectNightHrTier, globalBaselines, NIGHT_TIER_MIN_GAPS } from '../correct'
import { correctNightSql, detectHrTierSql, morningVitalsSql } from '../sql'

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

/** HR only, at the given cadence (seconds) from `from` for `hours`. */
async function hrDb(runs: { from: string, hours: number, every: number }[]): Promise<SqlRunner & { close?: () => Promise<void> }> {
  const db = await createRealDuckDB([])
  await db.execute(`CREATE TABLE stg_heartrate (date BIGINT, "singleHR" DOUBLE)`)
  const hr: string[] = []
  for (const run of runs) {
    const s = at(run.from)
    for (let t = s; t < s + run.hours * 3600; t += run.every)
      hr.push(`(${t}, 62)`)
  }
  for (let i = 0; i < hr.length; i += 2000)
    await db.execute(`INSERT INTO stg_heartrate VALUES ${hr.slice(i, i + 2000).join(',')}`)
  return db
}

describe('HR tier per night (packages#68)', () => {
  const night = (iso: string) => computeNightEpochs(iso, 0)

  it('stages each night at its own cadence after a change, where the whole-history median lags', async () => {
    // 60 days every 30 min, then 5 days every 5 min.
    const db = await hrDb([
      { from: '2026-05-01T18:00:00', hours: 60 * 24, every: 1800 },
      { from: '2026-06-30T18:00:00', hours: 5 * 24, every: 300 },
    ])
    expect(await detectHrTier(db)).toBe(30) // v3.1: the old cadence still holds the median
    const n = night('2026-07-03')
    expect(await detectNightHrTier(db, n.windowStart, n.windowEnd)).toEqual({ tier: 5, source: 'night' })
    const old = night('2026-06-10')
    expect(await detectNightHrTier(db, old.windowStart, old.windowEnd)).toEqual({ tier: 30, source: 'night' })
    await db.close?.()
  }, 60_000)

  it('matches the whole-history tier on a ring whose cadence never changed', async () => {
    const db = await hrDb([{ from: '2026-06-01T18:00:00', hours: 20 * 24, every: 600 }])
    const n = night('2026-06-15')
    expect(await detectHrTier(db)).toBe(10)
    expect(await detectNightHrTier(db, n.windowStart, n.windowEnd)).toEqual({ tier: 10, source: 'night' })
    await db.close?.()
  }, 60_000)

  it('a thin night takes the 14 days ending at it, unaffected by anything later', async () => {
    // 20 days every 10 min, one thin night (a few 5-min readings), then 30 days every 5 min.
    const db = await hrDb([
      { from: '2026-06-01T18:00:00', hours: 20 * 24, every: 600 },
      { from: '2026-06-21T20:00:00', hours: 0.5, every: 300 },
      { from: '2026-06-23T18:00:00', hours: 30 * 24, every: 300 },
    ])
    const thin = night('2026-06-22')
    const tier = await detectNightHrTier(db, thin.windowStart, thin.windowEnd)
    expect(tier).toEqual({ tier: 10, source: 'recent' })
    await db.close?.()
  }, 60_000)

  it('the night needs NIGHT_TIER_MIN_GAPS gaps; with none anywhere it is tier 30', async () => {
    const n = night('2026-06-22')
    // Exactly the threshold: 10 gaps at 5 min ⇒ judged on the night.
    const enough = await hrDb([
      { from: '2026-06-01T18:00:00', hours: 20 * 24, every: 1800 },
      { from: '2026-06-22T01:00:00', hours: (NIGHT_TIER_MIN_GAPS + 1) * 300 / 3600, every: 300 },
    ])
    expect(await detectNightHrTier(enough, n.windowStart, n.windowEnd)).toEqual({ tier: 5, source: 'night' })
    await enough.close?.()

    const empty = await hrDb([])
    expect(await detectNightHrTier(empty, n.windowStart, n.windowEnd)).toEqual({ tier: 30, source: 'recent' })
    await empty.close?.()
  }, 60_000)
})

describe('morningVitalsSql order (#52)', () => {
  it('orders samples that share an epoch by kind, then value, whatever the insert order', async () => {
    const db = await createRealDuckDB([])
    await db.execute(`CREATE TABLE stg_heartrate (date BIGINT, "singleHR" DOUBLE)`)
    await db.execute(`CREATE TABLE stg_activity (date BIGINT, step DOUBLE)`)
    await db.execute(`INSERT INTO stg_heartrate VALUES (100, 90), (100, 60), (40, 70)`)
    await db.execute(`INSERT INTO stg_activity VALUES (100, 5)`)
    const rows = (await db.execute(morningVitalsSql(0, 100))) as { kind: string, epoch: unknown, value: unknown }[]
    expect(rows.map(r => [r.kind, Number(r.epoch), Number(r.value)])).toEqual([
      ['hr', 40, 70],
      ['hr', 100, 60],
      ['hr', 100, 90],
      ['step', 100, 5],
    ])
  })
})
