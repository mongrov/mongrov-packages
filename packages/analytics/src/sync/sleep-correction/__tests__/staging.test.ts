/**
 * The production path in miniature: warehouse tables built from the REAL DDL
 * (principle 62), the v_* views, the staging views on top, and the multi-night
 * orchestrator — on the same synthetic night `correct.test.ts` stages
 * directly. Same answer both ways is the check that the staging views reshape
 * the warehouse into exactly what the ported SQL expects.
 */
import type { SqlRunner } from '../correct'

import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../../__integration__/setup/real-engine'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../../core/schemas'
import { correctNight } from '../correct'
import { nightWindow } from '../night'
import { correctSleepNights, nightsForEpochs } from '../orchestrate'
import { stagingViewsSql } from '../staging'

const BRAND = 'ziva'
const FAMILY = 'fam_1'
const at = (iso: string) => Date.parse(`${iso}Z`) / 1000
const ts = (e: number) => new Date(e * 1000).toISOString().slice(0, 19).replace('T', ' ')

async function warehouse(): Promise<SqlRunner & { close?: () => Promise<void> }> {
  const db = await createRealDuckDB([])
  for (const t of ['sleep_raw', 'heart_rate', 'activity'] as const)
    await db.execute(LOCAL_SCHEMAS[t].replace(`CREATE TABLE ${t}`, `CREATE TABLE memory.${t}`))
  for (const t of ['heart_rate', 'activity'] as const)
    await db.execute(generateViewDdl(t, { brand: BRAND, familyId: FAMILY, localCatalog: 'memory' }))

  // The synthetic night for u1/ring_1 — and a decoy for u2 that must not leak in.
  const sleep: string[] = []
  const session = (user: string, from: string, minutes: number) => {
    const s = at(from)
    for (let i = 0; i <= minutes; i++)
      sleep.push(`('${ts(s + i * 60)}', '${ts(s)}', '${BRAND}', '${FAMILY}', '${user}', 'ring_1', 2, 1)`)
  }
  session('u1', '2026-06-17T23:00:00', 120)
  session('u1', '2026-06-18T01:30:00', 150)
  session('u2', '2026-06-17T20:00:00', 60)
  await db.execute(`INSERT INTO memory.sleep_raw (ts, ts_session_start, brand, family_id, user_id, device_id, quality, unit_length) VALUES ${sleep.join(',')}`)

  const hr: string[] = []
  for (let t = at('2026-06-17T22:00:00'); t <= at('2026-06-18T06:00:00'); t += 300) {
    hr.push(`('${ts(t)}', '${BRAND}', '${FAMILY}', 'u1', 'ring_1', 60)`)
    hr.push(`('${ts(t)}', '${BRAND}', '${FAMILY}', 'u2', 'ring_1', 110)`)
  }
  await db.execute(`INSERT INTO memory.heart_rate (ts, brand, family_id, user_id, device_id, bpm) VALUES ${hr.join(',')}`)

  for (const sql of stagingViewsSql({ brand: BRAND, familyId: FAMILY, userId: 'u1', deviceId: 'ring_1' }))
    await db.execute(sql)
  return db
}

describe('staging views over the warehouse', () => {
  it('reshape the real DDL into what the ported SQL reads — same night as direct staging', async () => {
    const db = await warehouse()
    const w = nightWindow('2026-06-18', 'UTC')
    const res = await correctNight(db, { ...w, hrIntervalMin: 5, p75: 80, p90: 90 })
    await db.close?.()

    expect(res.status).toBe('ok')
    if (res.status !== 'ok')
      return
    // u2's 20:00 session never appears: the night still opens at 23:00.
    expect(res.rows[0].date).toBe('2026.06.17 23:00:00')
    expect(res.rows[res.rows.length - 1].date).toBe('2026.06.18 06:00:00')
    expect(new Set(res.rows.map(r => r.block_type))).toEqual(new Set(['primary']))
  }, 60_000)
})

describe('correctSleepNights', () => {
  it('corrects each touched night once, with its own window and the two scalars', async () => {
    const db = await warehouse()
    const out = await correctSleepNights(db, { nights: ['2026-06-18', '2026-06-25'], timeZone: 'UTC', cutoffEpoch: 0 })
    await db.close?.()

    expect(out).toMatchObject({ hrIntervalMin: 5, p75: 60, p90: 60 })
    const [night, empty] = out.nights
    expect(night).toMatchObject({ night: '2026-06-18', status: 'ok', settleMin: 0, tzOffsetHours: 0 })
    expect(night.recoveredMin).toBeGreaterThan(0) // the 01:00–01:30 hole and the tail
    expect(empty).toMatchObject({ night: '2026-06-25', status: 'no_firmware_sleep' })
  }, 60_000)

  it('contains a failing night: it is reported, the others still run', async () => {
    const db = await warehouse()
    const bad = nightWindow('2026-06-18', 'UTC').windowStart
    const flaky: SqlRunner = {
      execute: sql => (sql.includes(`date >= ${bad}`) ? Promise.reject(new Error('boom')) : db.execute(sql)),
    }
    const out = await correctSleepNights(flaky, { nights: ['2026-06-18', '2026-06-25'], timeZone: 'UTC', cutoffEpoch: 0 })
    await db.close?.()
    expect(out.nights.map(n => n.status)).toEqual(['failed', 'no_firmware_sleep'])
    expect(out.nights[0].error).toBe('boom')
  }, 60_000)
})

describe('nightsForEpochs', () => {
  it('attributes instants to 6pm→6pm local nights', () => {
    expect(nightsForEpochs([at('2026-06-17T23:30:00'), at('2026-06-18T03:00:00')], 'UTC')).toEqual(['2026-06-18'])
    expect(nightsForEpochs([at('2026-06-18T19:00:00')], 'UTC')).toEqual(['2026-06-19'])
    // 13:00 UTC is 18:30 in Kolkata — already the next night there.
    expect(nightsForEpochs([at('2026-06-17T13:00:00')], 'Asia/Kolkata')).toEqual(['2026-06-18'])
  })
})
