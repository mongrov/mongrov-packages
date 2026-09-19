/**
 * HR's phase-band rails, on real DuckDB (D-H, zivaone_app T-26).
 *
 * Every day is seeded identically, so each rail's value can be worked out by
 * hand: twelve readings a..a+11 have quantile_cont p10 = a + 1.1 and
 * p90 = a + 9.9, and the median across identical days is that day's edge.
 * A wrong phase classification moves a whole block of readings into the
 * wrong rail and shows up as a number that is off by tens, not decimals.
 */

import { describe, expect, it } from 'vitest'
import { createQualityViews } from '../../__integration__/setup/quality-views'
import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { BASELINE_MIN_DAYS } from '../../core/metric_metadata'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../core/schemas'
import { buildHrPhaseBandsSql, HR_PHASE_BAND_METRICS } from '../hr-phase-bands'

const B = 'ziva'
const F = 'f'
const U = 'u'

function daysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

async function boot() {
  const db = await createRealDuckDB(['icu'])
  for (const t of ['heart_rate', 'sleep_session', 'activity'] as const) {
    await db.execute(LOCAL_SCHEMAS[t].replace(`CREATE TABLE ${t}`, `CREATE TABLE memory.${t}`))
    await db.execute(generateViewDdl(t, { brand: B, familyId: F, localCatalog: 'memory' }))
  }
  await createQualityViews(db, { brand: B, familyId: F })
  return db
}
type Db = Awaited<ReturnType<typeof boot>>

/** Twelve readings from `hh:00`, one every 10 minutes, `base`..`base + 11`. */
async function block(db: Db, day: string, hh: string, base: number) {
  const values = Array.from({ length: 12 }, (_, i) => {
    const h = String(Number(hh) + Math.floor((i * 10) / 60)).padStart(2, '0')
    const m = String((i * 10) % 60).padStart(2, '0')
    return `(TIMESTAMP '${day} ${h}:${m}:00', '${B}','${F}','${U}','ring', ${base + i})`
  })
  await db.execute(`INSERT INTO memory.heart_rate (ts, brand, family_id, user_id, device_id, bpm) VALUES ${values.join(',')}`)
}

async function seedDay(db: Db, d: number) {
  const day = daysAgo(d)
  await db.execute(
    `INSERT INTO memory.sleep_session (session_id, ts_start, ts_end, brand, family_id, user_id, device_id, total_minutes)
     VALUES ('n${d}', TIMESTAMP '${day} 00:00:00', TIMESTAMP '${day} 06:00:00', '${B}','${F}','${U}','ring', 360)`,
  )
  await block(db, day, '01', 50) // asleep: inside the session
  await block(db, day, '09', 65) // awake: still, outside the session
  await block(db, day, '15', 110) // active: walking
  // Steps every minute 14:40-17:20, so every active reading has >= 50 steps
  // within +/-15 min and no awake reading (09:00-10:50) is near any.
  await db.execute(
    `INSERT INTO memory.activity (ts, brand, family_id, user_id, device_id, steps)
     SELECT TIMESTAMP '${day} 14:40:00' + (i * INTERVAL 1 MINUTE), '${B}','${F}','${U}','ring', 60
     FROM range(0, 160) t(i)`,
  )
}

async function rails(db: Db, windowDays = 30) {
  const rows = await db.execute<{ metric: string, p50: number, sample_count: number }>(buildHrPhaseBandsSql(), {
    userId: U,
    brand: B,
    familyId: F,
    tz: 'UTC',
    windowDays,
  })
  return Object.fromEntries(rows.map(r => [r.metric, { p50: Number(r.p50), days: Number(r.sample_count) }]))
}

describe('hR phase-band rails', () => {
  it('writes all six rails, each phase from its own readings', async () => {
    const db = await boot()
    for (let d = 1; d <= 25; d += 1) await seedDay(db, d)
    const r = await rails(db)
    expect(Object.keys(r).sort()).toEqual([...HR_PHASE_BAND_METRICS].sort())
    expect(r.hr_asleep_lo!.p50).toBeCloseTo(51.1, 5)
    expect(r.hr_asleep_hi!.p50).toBeCloseTo(59.9, 5)
    expect(r.hr_awake_lo!.p50).toBeCloseTo(66.1, 5)
    expect(r.hr_awake_hi!.p50).toBeCloseTo(74.9, 5)
    expect(r.hr_active_lo!.p50).toBeCloseTo(111.1, 5)
    expect(r.hr_active_hi!.p50).toBeCloseTo(119.9, 5)
    // Days, not readings.
    expect(r.hr_asleep_lo!.days).toBe(25)
    await db.close?.()
  }, 120_000)

  it('writes nothing before BASELINE_MIN_DAYS days — learning, not a thin band', async () => {
    const db = await boot()
    for (let d = 1; d < BASELINE_MIN_DAYS; d += 1) await seedDay(db, d)
    await expect(rails(db)).resolves.toEqual({})
    await db.close?.()
  }, 120_000)

  it('reads clean readings: an implausible spike never moves a rail', async () => {
    const db = await boot()
    for (let d = 1; d <= 25; d += 1) await seedDay(db, d)
    // 250 bpm inside the night, every night. Raw, it would lift asleep_hi.
    for (let d = 1; d <= 25; d += 1)
      await db.execute(`INSERT INTO memory.heart_rate (ts, brand, family_id, user_id, device_id, bpm) VALUES (TIMESTAMP '${daysAgo(d)} 01:05:00', '${B}','${F}','${U}','ring', 250)`)
    const r = await rails(db)
    expect(r.hr_asleep_hi!.p50).toBeCloseTo(59.9, 5)
    await db.close?.()
  }, 120_000)

  it('counts complete days only — today never contributes', async () => {
    const db = await boot()
    for (let d = 1; d <= 25; d += 1) await seedDay(db, d)
    await seedDay(db, 0)
    expect((await rails(db)).hr_asleep_lo!.days).toBe(25)
    await db.close?.()
  }, 120_000)
})
