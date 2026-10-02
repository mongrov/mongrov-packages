/**
 * zivaone_app#366 — a reading is judged by the steps of the ring that took it.
 *
 * `still` differenced a running step total kept per TENANT, so a second ring's
 * activity in the same minutes counted against this ring's reading: another
 * ring's 60 steps flipped an idle ring's SpO2 reading to MOVING and dropped it
 * from the clean view. Two rings with overlapping activity on one account is
 * real: a replacement ring arrives carrying its own history, QA rings move
 * between testers, and the QA seed writes a mock ring next to the real one.
 *
 * `v_motion` keeps its per-tenant `cum_steps` (the app's day grids read it to
 * describe the user's day) and gains `cum_steps_device`, which the gate reads.
 */

import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { HybridDuckDB } from '../engine'
import { qualityMacroDdls, qualityMacroFor, qualityViewDdls } from '../reading-quality'
import { LOCAL_SCHEMAS } from '../schemas'

const COLS = 'brand, family_id, user_id, device_id'
const ids = (ring: string) => `'ziva','fam','u','${ring}'`

async function rig() {
  const db = new HybridDuckDB(() => createRealDuckDB([]))
  await db.open()
  const tables = ['spo2', 'activity', 'temperature', 'heart_rate', 'hrv'] as const
  for (const t of tables)
    await db.execute(LOCAL_SCHEMAS[t])
  for (const t of tables)
    await db.execute(`CREATE OR REPLACE VIEW v_${t} AS SELECT * FROM ${t};`)
  for (const v of qualityViewDdls())
    await db.execute(v.sql)
  for (const m of qualityMacroDdls())
    await db.execute(m.sql)
  return db
}

const READING = '2026-09-20T10:00:00'

/**
 * Ring B takes a SpO2 reading at 10:00 and records zero steps every minute
 * around it. Ring A, same account, records `otherSteps` at 10:02.
 */
async function twoRings(otherSteps: number) {
  const db = await rig()
  await db.execute(`INSERT INTO temperature (ts, ${COLS}, temp_c) VALUES (TIMESTAMP '2026-09-20T09:50:00', ${ids('ringB')}, 36.5);`)
  await db.execute(`INSERT INTO spo2 (ts, ${COLS}, spo2) VALUES (TIMESTAMP '${READING}', ${ids('ringB')}, 97);`)
  for (let m = 45; m <= 59; m++)
    await db.execute(`INSERT INTO activity (ts, ${COLS}, steps) VALUES (TIMESTAMP '2026-09-20T09:${m}:00', ${ids('ringB')}, 0);`)
  for (let m = 0; m <= 15; m++)
    await db.execute(`INSERT INTO activity (ts, ${COLS}, steps) VALUES (TIMESTAMP '2026-09-20T10:${String(m).padStart(2, '0')}:00', ${ids('ringB')}, 0);`)
  await db.execute(`INSERT INTO activity (ts, ${COLS}, steps) VALUES (TIMESTAMP '2026-09-20T10:02:00', ${ids('ringA')}, ${otherSteps});`)
  return db
}

describe('still is judged by the reading\'s own ring (#366)', () => {
  it('another ring walking in the same minutes does not make this ring\'s reading MOVING', async () => {
    const db = await twoRings(60)

    const rows = await db.execute<{ still: boolean, clean: boolean }>(`SELECT still, clean FROM v_spo2_q`)

    expect(rows).toEqual([{ still: true, clean: true }])
  })

  it('the bounded macro path agrees with the view', async () => {
    const db = await twoRings(60)

    const rows = await db.execute<{ still: boolean }>(
      `SELECT still FROM ${qualityMacroFor('spo2')}(TIMESTAMP '2026-09-20T09:00:00', TIMESTAMP '2026-09-20T11:00:00')`,
    )

    expect(rows.map(r => r.still)).toEqual([true])
  })

  it('this ring\'s OWN steps still count: 60 of them is MOVING', async () => {
    const db = await twoRings(0)
    await db.execute(`UPDATE activity SET steps = 60 WHERE device_id = 'ringB' AND ts = TIMESTAMP '2026-09-20T10:02:00'`)

    const rows = await db.execute<{ still: boolean }>(`SELECT still FROM v_spo2_q`)

    expect(rows.map(r => r.still)).toEqual([false])
  })

  it('another ring\'s rows are not evidence for this one: none of its own is unknown', async () => {
    const db = await rig()
    await db.execute(`INSERT INTO spo2 (ts, ${COLS}, spo2) VALUES (TIMESTAMP '${READING}', ${ids('ringB')}, 97);`)
    await db.execute(`INSERT INTO activity (ts, ${COLS}, steps) VALUES (TIMESTAMP '2026-09-20T10:02:00', ${ids('ringA')}, 0);`)

    const rows = await db.execute<{ still: boolean | null }>(`SELECT still FROM v_spo2_q`)

    expect(rows.map(r => r.still)).toEqual([null])
  })

  it('v_motion\'s per-tenant cum_steps is unchanged — the app\'s day grids read it', async () => {
    const db = await twoRings(60)

    const [row] = await db.execute<{ total: number | bigint, ringB: number | bigint }>(
      `SELECT max(cum_steps) AS total,
              max(cum_steps_device) FILTER (WHERE device_id = 'ringB') AS ringB
         FROM v_motion`,
    )

    expect(Number(row.total)).toBe(60) // both rings, as before
    expect(Number(row.ringB)).toBe(0) // ring B alone
  })
})
