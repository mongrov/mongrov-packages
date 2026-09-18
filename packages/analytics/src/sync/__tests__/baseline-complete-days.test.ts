/**
 * A daily baseline is built from COMPLETE local days that count as days.
 *
 * The daily-value CTE used to take every local day touched by
 * `ts > now() - N days`. That window has two partial days in it: today, still
 * accumulating, and the oldest day, cut at the current time of day. For a
 * summed metric the partial days are simply small numbers: a 500-step morning
 * sat in the same distribution as 10,000-step days and dragged the usual band
 * down. For an averaged metric, a day with two readings counted as a day,
 * though the rules' day cadence and every trend floor treat it as absent.
 *
 * Now: whole local days only, today excluded, and an averaged metric's day
 * needs `minDayReadings` readings, the floor the rules already apply.
 */

import { describe, expect, it } from 'vitest'
import { createQualityViews } from '../../__integration__/setup/quality-views'
import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../core/schemas'
import { buildBaselineSql } from '../baseline-compute'

const B = 'ziva'
const F = 'f'
const U = 'u'

/** `YYYY-MM-DD` of the UTC day `n` days before today (tz is UTC below). */
function daysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

async function boot() {
  const db = await createRealDuckDB(['icu'])
  for (const t of ['spo2', 'activity', 'temperature'] as const) {
    await db.execute(LOCAL_SCHEMAS[t].replace(`CREATE TABLE ${t}`, `CREATE TABLE memory.${t}`))
    await db.execute(generateViewDdl(t, { brand: B, familyId: F, localCatalog: 'memory' }))
  }
  await createQualityViews(db, { brand: B, familyId: F })
  return db
}

type Db = Awaited<ReturnType<typeof boot>>

async function steps(db: Db, day: string, time: string, n: number) {
  await db.execute(
    `INSERT INTO memory.activity (ts, brand, family_id, user_id, device_id, steps)
     VALUES (TIMESTAMP '${day} ${time}', '${B}','${F}','${U}','ring', ${n})`,
  )
}

async function spo2(db: Db, day: string, time: string, v: number) {
  await db.execute(
    `INSERT INTO memory.spo2 (ts, brand, family_id, user_id, device_id, spo2)
     VALUES (TIMESTAMP '${day} ${time}', '${B}','${F}','${U}','ring', ${v})`,
  )
}

async function baseline(db: Db, metric: 'activity_steps' | 'spo2') {
  const rows = await db.execute<{ p10: number, p50: number, mean: number, sample_count: number }>(
    buildBaselineSql(metric, 30),
    { userId: U, brand: B, familyId: F, tz: 'UTC', windowDays: 30 },
  )
  return rows[0]
}

describe('daily baselines read complete local days only', () => {
  it('a summed metric leaves today\'s partial total out of the usual band', async () => {
    const db = await boot()
    for (let d = 1; d <= 25; d += 1) {
      await steps(db, daysAgo(d), '09:00:00', 6000)
      await steps(db, daysAgo(d), '17:00:00', 4000)
    }
    // Today so far: one short walk. Counted as a day, it was the band's low.
    await steps(db, daysAgo(0), '00:05:00', 500)

    // mean, not a quantile: one partial day barely moves p10, but every day
    // is in the mean, so this is the assertion a partial day cannot hide from.
    const row = await baseline(db, 'activity_steps')
    expect(Number(row?.mean)).toBe(10000)
    expect(Number(row?.sample_count)).toBe(25)
    await db.close?.()
  }, 60_000)

  it('the oldest day in the window is not a partial day', async () => {
    const db = await boot()
    for (let d = 1; d <= 30; d += 1) {
      await steps(db, daysAgo(d), '00:10:00', 3000)
      await steps(db, daysAgo(d), '23:50:00', 7000)
    }
    // `now() - 30 days` cuts day 30 at the current time of day, so for most
    // of the day only its 23:50 reading was inside: a 7000-step "day" among
    // 10,000-step ones. A 30-day window is days 1..30, each whole.
    //
    // Day 31 is outside it. Its late reading sits inside the scan's one day
    // of zone slack, so only the lower day bound keeps it out.
    await steps(db, daysAgo(31), '00:10:00', 3000)
    await steps(db, daysAgo(31), '23:50:00', 7000)

    const row = await baseline(db, 'activity_steps')
    expect(Number(row?.mean)).toBe(10000)
    expect(Number(row?.sample_count)).toBe(30)
    await db.close?.()
  }, 60_000)

  it('an averaged metric\'s thin day does not count, at the rules\' floor', async () => {
    const db = await boot()
    // 22 full nights at 97 (12 readings each — spo2's floor is 12).
    for (let d = 1; d <= 22; d += 1) {
      for (let i = 0; i < 12; i += 1)
        await spo2(db, daysAgo(d), `0${Math.floor(i / 2)}:${i % 2 ? '30' : '00'}:00`, 97)
    }
    // Two thin days at 80: one on a past day, one today. Neither is a day by
    // the floor every other consumer applies.
    await spo2(db, daysAgo(23), '03:00:00', 80)
    await spo2(db, daysAgo(23), '03:30:00', 80)
    await spo2(db, daysAgo(0), '00:30:00', 80)

    const row = await baseline(db, 'spo2')
    expect(Number(row?.mean)).toBe(97)
    expect(Number(row?.sample_count)).toBe(22)
    await db.close?.()
  }, 60_000)
})
