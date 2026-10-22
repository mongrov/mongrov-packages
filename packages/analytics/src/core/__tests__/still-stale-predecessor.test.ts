/**
 * zivaone_app#219 (2026-10-01 device evidence) — a previous activity row far
 * older than the window must not inflate the step count.
 *
 * The probe reported a reading whose nearest EARLIER activity row sat 1435
 * minutes before the window opened, 40 steps inside the window, and a verdict
 * of MOVING on a count of 103. The suspicion was that `cum(mn) - cum(mp)`
 * counts every step since that distant row.
 *
 * It cannot: `mp` is the LATEST row before the window opens, so by definition
 * no row of the same ring lies between `mp` and the window, and the difference
 * is exactly the in-window steps. Pinned here on real DuckDB with the probe's
 * own row layout. The 103 is what a per-TENANT total gives when a second ring
 * contributes 63 steps in the same minutes — the zivaone_app#366 defect, fixed
 * in 0.36.0, which the probe ran before.
 */

import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { HybridDuckDB } from '../engine'
import { qualityMacroDdls, qualityViewDdls } from '../reading-quality'
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

/** The probe's rows, UTC: reading 01:30:22, window [01:15:22, 01:45:22). */
async function probeLayout(otherRingSteps: number | null) {
  const db = await rig()
  await db.execute(`INSERT INTO temperature (ts, ${COLS}, temp_c) VALUES (TIMESTAMP '2026-10-01T01:20:00', ${ids('ringB')}, 36.5);`)
  await db.execute(`INSERT INTO spo2 (ts, ${COLS}, spo2) VALUES (TIMESTAMP '2026-10-01T01:30:22', ${ids('ringB')}, 98);`)
  // The stale predecessor: 1435 minutes before the window opens, carrying a
  // day's worth of steps that must stay OUT of the count.
  await db.execute(`INSERT INTO activity (ts, ${COLS}, steps) VALUES (TIMESTAMP '2026-09-30T01:20:22', ${ids('ringB')}, 5000);`)
  const inWindow: Array<[string, number]> = [
    ['01:31:19', 0],
    ['01:32:19', 0],
    ['01:37:19', 40],
    ['01:38:19', 0],
    ['01:39:19', 0],
    ['01:40:19', 0],
    ['01:41:19', 0],
    ['01:42:19', 0],
    ['01:43:19', 0],
    ['01:44:19', 0],
    ['01:45:19', 0],
  ]
  for (const [t, steps] of inWindow)
    await db.execute(`INSERT INTO activity (ts, ${COLS}, steps) VALUES (TIMESTAMP '2026-10-01T${t}', ${ids('ringB')}, ${steps});`)
  if (otherRingSteps !== null)
    await db.execute(`INSERT INTO activity (ts, ${COLS}, steps) VALUES (TIMESTAMP '2026-10-01T01:35:00', ${ids('ringA')}, ${otherRingSteps});`)
  return db
}

describe('a stale predecessor row does not inflate the still count (#219, 2026-10-01)', () => {
  it('40 in-window steps with the previous row a day earlier is STILL', async () => {
    const db = await probeLayout(null)
    const rows = await db.execute<{ still: boolean, clean: boolean }>(`SELECT still, clean FROM v_spo2_q`)
    expect(rows).toEqual([{ still: true, clean: true }])
  })

  it('a second ring\'s 63 steps in the window explain the probe\'s 103 — and no longer count (#366)', async () => {
    const db = await probeLayout(63)
    const rows = await db.execute<{ still: boolean, clean: boolean }>(`SELECT still, clean FROM v_spo2_q`)
    expect(rows).toEqual([{ still: true, clean: true }])

    // What the pre-0.36.0 per-tenant total would have differenced: the
    // probe's 103.
    const tenant = await db.execute<{ delta: number }>(`
      SELECT (mn.cum_steps - mp.cum_steps)::INTEGER AS delta
      FROM v_spo2 m
      ASOF LEFT JOIN v_motion mp ON mp.user_id = m.user_id AND mp.brand = m.brand AND mp.family_id = m.family_id
        AND m.ts - INTERVAL 15 MINUTE > mp.ts
      ASOF LEFT JOIN v_motion mn ON mn.user_id = m.user_id AND mn.brand = m.brand AND mn.family_id = m.family_id
        AND m.ts + INTERVAL 15 MINUTE > mn.ts`)
    expect(tenant).toEqual([{ delta: 103 }])
  })
})
