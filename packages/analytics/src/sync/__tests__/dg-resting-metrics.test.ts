/**
 * D-G's two HR-derived metrics, executed against real DuckDB.
 *
 * The names carry the whole ruling, so both are tested against data where the
 * WRONG metric would give a different, plausible answer:
 *
 *   resting_hr         nightly LOW      — how low you settle overnight
 *   resting_gated_avg  still-time MEAN  — your rate while not moving, by day
 *
 * An implementation that confused them would still return a number in the
 * right range, which is why these seed a day whose still-time mean and
 * nightly low are far apart.
 */

import { describe, expect, it } from 'vitest'
import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../core/schemas'
import { buildBaselineSql } from '../baseline-compute'

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
  return db
}

async function hr(db: Awaited<ReturnType<typeof boot>>, day: string, hour: string, bpm: number) {
  await db.execute(
    `INSERT INTO memory.heart_rate (ts, brand, family_id, user_id, device_id, bpm)
     VALUES (TIMESTAMP '${day} ${hour}:00:00', '${B}','${F}','${U}','ring', ${bpm})`,
  )
}

describe('D-G — resting_hr is the nightly low', () => {
  it('takes the MINIMUM inside the sleep session, not the day average', async () => {
    const db = await boot()
    // 20 nights: the baseline needs BASELINE_MIN_DAYS before it returns
    // anything. Every night is identical, so p50 of the minima is that
    // night's minimum.
    for (let d = 1; d <= 20; d += 1) {
      const day = daysAgo(d)
      await db.execute(
        `INSERT INTO memory.sleep_session (session_id, ts_start, ts_end, brand, family_id, user_id, device_id, total_minutes)
         VALUES ('n${d}', TIMESTAMP '${day} 00:00:00', TIMESTAMP '${day} 06:00:00', '${B}','${F}','${U}','ring', 360)`,
      )
      // In-sleep: 52, 48, 61. Nightly low is 48; the mean would be 53.7.
      for (const [h, v] of [['01', 52], ['03', 48], ['05', 61]] as const) await hr(db, day, h, v)
      // Daytime 90 must not enter — it is outside the session.
      await hr(db, day, '14', 90)
    }

    const sql = buildBaselineSql('resting_hr', 30)
    const rows = await db.execute<{ p50: number }>(sql, {
      userId: U,
      brand: B,
      familyId: F,
      tz: 'UTC',
      windowDays: 30,
    })
    expect(Number(rows[0]?.p50)).toBe(48)
    await db.close?.()
  }, 60_000)
})

describe('D-G — resting_gated_avg is the still-time mean', () => {
  it('averages only readings with no movement within ±15 min', async () => {
    const db = await boot()
    for (let d = 1; d <= 20; d += 1) {
      const day = daysAgo(d)
      // 60 and 70 while still -> mean 65. The 120 at 14:00 has steps at 14:05.
      await hr(db, day, '09', 60)
      await hr(db, day, '11', 70)
      await hr(db, day, '14', 120)
      await db.execute(
        `INSERT INTO memory.activity (ts, brand, family_id, user_id, device_id, steps)
         VALUES (TIMESTAMP '${day} 14:05:00', '${B}','${F}','${U}','ring', 400)`,
      )
    }

    const sql = buildBaselineSql('resting_gated_avg', 30)
    const rows = await db.execute<{ p50: number }>(sql, {
      userId: U,
      brand: B,
      familyId: F,
      tz: 'UTC',
      windowDays: 30,
    })
    // 65, not 83.3 — the exercise reading is excluded, which is the entire
    // reason this metric exists separately from hr_bpm.
    expect(Number(rows[0]?.p50)).toBe(65)
    await db.close?.()
  }, 60_000)
})
