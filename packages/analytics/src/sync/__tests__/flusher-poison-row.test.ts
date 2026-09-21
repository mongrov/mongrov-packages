/**
 * One unwritable value must not cost the whole table, forever
 * (zivaone_app#226).
 *
 * A real ring sent a filler temperature sample read unsigned: 65378 * 0.1 =
 * 6537.8, which `temp_c DECIMAL(4,1)` cannot hold. The cast failed, the whole
 * 662-row batch was rejected, and the batch was released back to the buffer —
 * by design, since T-45 keeps durable rows until a write commits. So the same
 * row was retried on every later flush and temperature could never write
 * again. Its delta cursor is the newest stored row, so it never advanced
 * either: every sync re-pulled the whole history and failed on the same row.
 *
 * These run on a real DuckDB: the failure is the Appender's cast, and a fake
 * engine would only assert what the fake was told to do.
 */

import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { HybridDuckDB } from '../../core/engine'
import { LOCAL_SCHEMAS } from '../../core/schemas'
import { SensorBuffer } from '../buffer'
import { BatchFlusher, MAX_CONSECUTIVE_FAILURES } from '../flusher'
import { OverflowStore } from '../overflow'

const TENANT = { brand: 'ziva', familyId: 'fam_1', userId: 'u1', deviceId: 'ring_1' }

async function rig() {
  const db = new HybridDuckDB(() => createRealDuckDB([]))
  await db.open()
  await db.execute(LOCAL_SCHEMAS.temperature)
  const cols = await db.execute<{ column_name: string }>(
    `SELECT column_name FROM duckdb_columns() WHERE table_name = 'temperature' ORDER BY column_index`,
  )
  const buffer = new SensorBuffer({ overflow: new OverflowStore(createFakeKV().kv) })
  const flusher = new BatchFlusher({
    engine: db,
    buffer,
    columnOrder: { temperature: cols.map(c => c.column_name) },
  })
  return { db, buffer, flusher }
}

/** `temp_c` is DECIMAL(4,1); 6537.8 is the value the ring actually sent. */
function reading(tsIso: string, tempC: number) {
  return {
    ts: new Date(tsIso),
    brand: TENANT.brand,
    family_id: TENANT.familyId,
    user_id: TENANT.userId,
    device_id: TENANT.deviceId,
    temp_c: tempC,
  }
}

/**
 * Flush until the table gives up on retrying.
 *
 * Dropping rows is irreversible, so the flusher will not do it to answer a
 * failure that might pass on its own: it spends the retry budget first, and
 * isolates only on the final attempt. A poison row therefore costs
 * MAX_CONSECUTIVE_FAILURES attempts — not the rest of time.
 */
async function flushToBudget(flusher: BatchFlusher, table: string) {
  const attempts = []
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1)
    attempts.push(await flusher.flush(table, 'manual'))
  return attempts
}

async function storedTemps(db: HybridDuckDB) {
  const rows = await db.execute<{ temp_c: number }>(
    `SELECT temp_c FROM temperature ORDER BY ts`,
  )
  return rows.map(r => Number(r.temp_c))
}

describe('a poison row does not cost the table', () => {
  it('writes the rows that cast and drops only the one that cannot', async () => {
    const r = await rig()
    await r.buffer.push({
      table: 'temperature',
      ...TENANT,
      rows: [
        reading('2026-09-21T01:00:00Z', 36.2),
        reading('2026-09-21T02:00:00Z', 6537.8), // the filler sample
        reading('2026-09-21T03:00:00Z', 36.4),
      ],
    })

    const attempts = await flushToBudget(r.flusher, 'temperature')

    // Every attempt before the last one fails and keeps the rows.
    expect(attempts.slice(0, -1).every(a => !a.ok)).toBe(true)
    expect(attempts.slice(0, -1).every(a => a.rowsRejected === undefined)).toBe(true)

    const result = attempts.at(-1)!
    expect(result.ok).toBe(true)
    expect(result.rowsFlushed).toBe(2)
    expect(result.rowsRejected).toBe(1)
    // The count alone does not say what was wrong; the sample names the value.
    expect(result.rejectedSample).toMatch(/6537\.8/)
    expect(await storedTemps(r.db)).toEqual([36.2, 36.4])
    await r.db.close()
  })

  it('does not retry the poison row on the next flush', async () => {
    const r = await rig()
    await r.buffer.push({
      table: 'temperature',
      ...TENANT,
      rows: [reading('2026-09-21T01:00:00Z', 6537.8), reading('2026-09-21T02:00:00Z', 36.2)],
    })
    await flushToBudget(r.flusher, 'temperature')

    // The next sync brings ordinary readings. Before the fix the buffer still
    // held the poison row, so this flush failed too and the metric stayed dead.
    await r.buffer.push({
      table: 'temperature',
      ...TENANT,
      rows: [reading('2026-09-21T03:00:00Z', 36.5)],
    })
    const second = await r.flusher.flush('temperature', 'manual')

    expect(second.ok).toBe(true)
    expect(second.rowsRejected).toBeUndefined()
    expect(await storedTemps(r.db)).toEqual([36.2, 36.5])
    await r.db.close()
  })

  it('writes each good row exactly once, though the batch is retried in parts', async () => {
    // `temperature` has no primary key, so nothing dedups a row written twice.
    // Classification runs against a scratch table for exactly this reason.
    const r = await rig()
    const rows = Array.from({ length: 40 }, (_, i) =>
      reading(`2026-09-21T04:${String(i).padStart(2, '0')}:00Z`, 36 + (i % 5) * 0.1))
    rows[17] = reading('2026-09-21T04:17:00Z', 6537.8)
    await r.buffer.push({ table: 'temperature', ...TENANT, rows })

    const result = (await flushToBudget(r.flusher, 'temperature')).at(-1)!

    expect(result.rowsRejected).toBe(1)
    const stored = await storedTemps(r.db)
    expect(stored).toHaveLength(39)
    const counts = await r.db.execute<{ n: number }>(
      `SELECT count(*) AS n FROM (SELECT ts FROM temperature GROUP BY ts HAVING count(*) > 1)`,
    )
    expect(Number(counts[0].n)).toBe(0)
    await r.db.close()
  })

  it('a dead engine is not read as "every row is bad"', async () => {
    // The dangerous failure mode of any isolate-and-drop scheme: if the write
    // fails because the connection is gone, classifying would reject every row
    // and silently discard a good batch. The batch must survive instead.
    const r = await rig()
    await r.buffer.push({
      table: 'temperature',
      ...TENANT,
      rows: [reading('2026-09-21T01:00:00Z', 36.2)],
    })
    await r.db.close()

    const result = (await flushToBudget(r.flusher, 'temperature')).at(-1)!

    expect(result.ok).toBe(false)
    expect(result.rowsRejected).toBeUndefined()
    const held = await r.buffer.size('temperature')
    expect(held.inMemory + held.overflow).toBeGreaterThan(0)
  })
})
