/**
 * Finding 4 of the 2026-09-26 review, at the level it actually bites.
 *
 * `conflictClause` chose `ON CONFLICT DO NOTHING` from `SCHEMAS` — the REMOTE
 * definitions — while every fetch insert writes to the LOCAL table.
 * `LOCAL_SCHEMAS` adds the declared identity tuple as a primary key to exactly
 * the sensor tables `SCHEMAS` leaves key-less, so the clause was omitted
 * precisely where it was needed and a re-fetch of an overlapping range failed
 * on a duplicate key instead of being idempotent.
 *
 * This runs the real statement shape against real DuckDB tables built from the
 * real DDL, because that is the only thing that distinguishes "the string
 * contains ON CONFLICT" from "the insert is actually idempotent".
 */
import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { HybridDuckDB } from '../../core/engine'
import { ensureSchemas, LOCAL_SCHEMAS, SCHEMAS } from '../../core/schemas'

const ROW = `('2026-06-01 00:00:00', 'ziva', 'fam', 'user', 'dev', 50)`
const COLS = `(ts, brand, family_id, user_id, device_id, hrv_ms)`

describe('conflictClause reads the destination schema', () => {
  it('hrv is key-less remotely but keyed locally — the asymmetry the bug lived in', () => {
    expect(SCHEMAS.hrv).not.toContain('PRIMARY KEY')
    expect(LOCAL_SCHEMAS.hrv).toContain('PRIMARY KEY')
  })

  it('re-inserting an already-local row is idempotent with the clause', async () => {
    const db = new HybridDuckDB(() => createRealDuckDB([]))
    await db.open()
    try {
      await ensureSchemas(db, 'memory', LOCAL_SCHEMAS)
      const insert = `INSERT INTO memory.hrv ${COLS} VALUES ${ROW} ON CONFLICT DO NOTHING`

      await db.execute(insert)
      // The second fetch of an overlapping range. Before the fix the clause
      // was absent here and this threw a duplicate-key error.
      await expect(db.execute(insert)).resolves.toBeDefined()

      const rows = await db.execute<{ n: number }>(
        `SELECT CAST(COUNT(*) AS INTEGER) AS n FROM memory.hrv`,
      )
      expect(Number(rows[0]?.n)).toBe(1)
    }
    finally {
      await db.close()
    }
  })

  it('without the clause the same second insert fails — the defect itself', async () => {
    const db = new HybridDuckDB(() => createRealDuckDB([]))
    await db.open()
    try {
      await ensureSchemas(db, 'memory', LOCAL_SCHEMAS)
      const bare = `INSERT INTO memory.hrv ${COLS} VALUES ${ROW}`

      await db.execute(bare)
      await expect(db.execute(bare)).rejects.toThrow()
    }
    finally {
      await db.close()
    }
  })
})
