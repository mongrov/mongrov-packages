/**
 * zivaone_app#219 — does `still` mark a reading as MOVING when there is no
 * motion evidence before it?
 *
 * `cum_steps` is a running total over ALL of v_activity, and
 *   still = (COALESCE(mn.cum_steps, 0) - COALESCE(mp.cum_steps, 0)) < FLOOR
 * `mp` is the total just before the window opens. When no activity row
 * precedes the reading, `mp` is NULL and COALESCEs to 0 — while `mn` carries
 * the running total, which is large by construction. The subtraction then
 * reports the user's ENTIRE step history as having happened inside a
 * 30-minute window.
 *
 * SpO2 is the only vital gated on `still` (with HRV), which is exactly the
 * asymmetry the report describes: HR and temperature render, SpO2 does not.
 */

import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { HybridDuckDB } from '../engine'
import { qualityViewDdls } from '../reading-quality'
import { LOCAL_SCHEMAS } from '../schemas'

const IDS = `'ziva','fam','u','ring'`
const COLS = 'brand, family_id, user_id, device_id'

async function rig() {
  const db = new HybridDuckDB(() => createRealDuckDB([]))
  await db.open()
  // Every quality table, since the `_q` views are created as a set.
  const tables = ['spo2', 'activity', 'temperature', 'heart_rate', 'hrv'] as const
  for (const t of tables)
    await db.execute(LOCAL_SCHEMAS[t])
  for (const t of tables)
    await db.execute(`CREATE OR REPLACE VIEW v_${t} AS SELECT * FROM ${t};`)
  for (const v of qualityViewDdls())
    await db.execute(v.sql)
  return db
}

/** Worn evidence, so `worn` cannot be the reason a reading is dropped. */
async function seedWear(db: HybridDuckDB, isos: string[]) {
  for (const iso of isos) {
    await db.execute(
      `INSERT INTO temperature (ts, ${COLS}, temp_c) VALUES (TIMESTAMP '${iso}', ${IDS}, 36.5);`,
    )
  }
}

describe('still, with no motion evidence before the reading (#219)', () => {
  it('keeps a reading taken before any activity row exists', async () => {
    const db = await rig()
    // A quiet night on the 10th. Activity data only starts on the 11th —
    // the ring synced steps later, or early activity was never written.
    await seedWear(db, ['2026-09-10T02:00:00', '2026-09-10T03:00:00'])
    await db.execute(
      `INSERT INTO spo2 (ts, ${COLS}, spo2) VALUES (TIMESTAMP '2026-09-10T03:00:00', ${IDS}, 97);`,
    )
    // A perfectly ordinary later day of walking.
    for (let i = 0; i < 60; i++) {
      await db.execute(
        `INSERT INTO activity (ts, ${COLS}, steps) VALUES (TIMESTAMP '2026-09-11T10:${String(i).padStart(2, '0')}:00', ${IDS}, 40);`,
      )
    }

    const rows = await db.execute<{ still: boolean, clean: boolean }>(
      `SELECT still, clean FROM v_spo2_q WHERE ts = TIMESTAMP '2026-09-10T03:00:00'`,
    )

    expect(rows).toHaveLength(1)
    // 3am, asleep, nothing moving. The only thing between this reading and
    // `still` is 2,400 steps taken the NEXT DAY.
    expect(rows[0].still).toBe(true)
    await db.close()
  })

  it('cannot be fooled by duplicated activity: the database refuses them', async () => {
    // The other hypothesis in #219 was that activity rows duplicate per sync,
    // inflating the running SUM that `still` subtracts. They cannot: every
    // metric table carries an identity PRIMARY KEY, injected programmatically
    // by `withIdentityKey` rather than spelled in the DDL string.
    //
    // This is easy to get wrong by reading `SCHEMAS`, where no key appears —
    // both the dedupe sweep in zivaone_app's warehouse-handoff and an earlier
    // version of these notes concluded the metric tables were unkeyed.
    const db = await rig()
    const insert = () => db.execute(
      `INSERT INTO activity (ts, ${COLS}, steps) VALUES (TIMESTAMP '2026-09-10T09:30:00', ${IDS}, 1);`,
    )
    await insert()
    // The AnalyticsError wraps the cause, so assert on the chain, not the
    // top-level message.
    const err = await insert().then(() => null, (e: unknown) => e as Error & { cause?: unknown })
    expect(err).not.toBeNull()
    expect(String(err?.cause ?? err?.message)).toMatch(/primary key|Duplicate key/i)
    await db.close()
  })
})
