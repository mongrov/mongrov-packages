/**
 * zivaone_app#219 — what `still` says when there is no motion evidence.
 *
 * The first question this file asked was whether a missing `mp` made the
 * subtraction report the user's ENTIRE step history as one window's worth,
 * marking the reading MOVING. It does not: with no activity row before the
 * window closes, `mn` is NULL too, both sides COALESCE to 0, and the
 * difference is 0.
 *
 * Which exposed the real defect, measured on a device: 0 is below any floor,
 * so the reading was called STILL because nothing had been recorded, not
 * because the wearer was motionless. SpO2 readings sitting 1-7 hours from the
 * nearest activity row all passed the gate. Overnight SpO2 was surviving
 * partly by accident and would have started failing had activity coverage
 * improved.
 *
 * `still` is three-valued now: true, false, or NULL for "we cannot tell".
 * The clean views keep unknown readings (`STILL_ENOUGH`), so what a screen
 * renders is unchanged — the honesty is in the flag, which is what the
 * quality probe reports and what a future consumer would reason from.
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
    // 3am, asleep, and not one activity row anywhere near it. We do not know
    // whether the wearer was still; saying `true` claimed we did.
    expect(rows[0].still).toBeNull()
    // The reading is still KEPT. This is the assertion the file was missing:
    // the flag moved, the filter did not, so no screen loses a reading to
    // this change.
    expect(rows[0].clean).toBe(true)
    await db.close()
  })

  it('says nothing when the nearest activity is hours away — the device case', async () => {
    // Exactly what the probe found on a real ring: readings whose nearest
    // activity row sat 1-7 hours off, every one of them passing as `still`.
    // The window is +/-15 minutes; a row 3 hours out is not evidence about it.
    const db = await rig()
    await seedWear(db, ['2026-09-10T08:00:00', '2026-09-10T09:00:00'])
    await db.execute(
      `INSERT INTO spo2 (ts, ${COLS}, spo2) VALUES (TIMESTAMP '2026-09-10T09:00:00', ${IDS}, 97);`,
    )
    // Activity exists, but 3 hours earlier and 3 hours later — never inside
    // the window. Both ASOF lookups land on the same distant row, so the
    // difference is 0 and the old predicate read that as stillness.
    for (const iso of ['2026-09-10T06:00:00', '2026-09-10T12:00:00']) {
      await db.execute(
        `INSERT INTO activity (ts, ${COLS}, steps) VALUES (TIMESTAMP '${iso}', ${IDS}, 500);`,
      )
    }

    const rows = await db.execute<{ still: boolean | null, clean: boolean }>(
      `SELECT still, clean FROM v_spo2_q WHERE ts = TIMESTAMP '2026-09-10T09:00:00'`,
    )

    expect(rows[0].still).toBeNull()
    expect(rows[0].clean).toBe(true)
    await db.close()
  })

  it('still answers true when the window HOLDS a quiet activity row', async () => {
    // The other side, and the one that keeps this from being "always NULL":
    // a zero-step minute inside the window IS evidence of stillness, which is
    // why `motionViewDdl` takes `steps IS NOT NULL` rather than `steps > 0`.
    const db = await rig()
    await seedWear(db, ['2026-09-10T08:00:00', '2026-09-10T09:00:00'])
    await db.execute(
      `INSERT INTO spo2 (ts, ${COLS}, spo2) VALUES (TIMESTAMP '2026-09-10T09:00:00', ${IDS}, 97);`,
    )
    for (const m of ['08:50', '08:55', '09:05'])
      await db.execute(`INSERT INTO activity (ts, ${COLS}, steps) VALUES (TIMESTAMP '2026-09-10T${m}:00', ${IDS}, 0);`)

    const rows = await db.execute<{ still: boolean | null, clean: boolean }>(
      `SELECT still, clean FROM v_spo2_q WHERE ts = TIMESTAMP '2026-09-10T09:00:00'`,
    )

    expect(rows[0].still).toBe(true)
    expect(rows[0].clean).toBe(true)
    await db.close()
  })

  it('still answers false when the window holds real movement', async () => {
    const db = await rig()
    await seedWear(db, ['2026-09-10T08:00:00', '2026-09-10T09:00:00'])
    await db.execute(
      `INSERT INTO spo2 (ts, ${COLS}, spo2) VALUES (TIMESTAMP '2026-09-10T09:00:00', ${IDS}, 97);`,
    )
    // Well past the 50-step floor, inside the window.
    for (const m of ['08:50', '08:55', '09:05'])
      await db.execute(`INSERT INTO activity (ts, ${COLS}, steps) VALUES (TIMESTAMP '2026-09-10T${m}:00', ${IDS}, 200);`)

    const rows = await db.execute<{ still: boolean | null, clean: boolean }>(
      `SELECT still, clean FROM v_spo2_q WHERE ts = TIMESTAMP '2026-09-10T09:00:00'`,
    )

    expect(rows[0].still).toBe(false)
    // And THIS one is dropped — moving is still a reason to exclude.
    expect(rows[0].clean).toBe(false)
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
