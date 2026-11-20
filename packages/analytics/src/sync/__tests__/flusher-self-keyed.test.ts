/**
 * Tables that declare their PRIMARY KEY in their own DDL (`sleep_session`,
 * `device_config`) must flush idempotently, like every IDENTITY_COLUMNS table.
 *
 * Found by the UX team's app-side patch (`patches/@mongrov__analytics@0.22.0.patch`,
 * flusher hunk) and confirmed here on a real DuckDB. The Appender enforces
 * primary keys and has no ON CONFLICT: re-flushing a row already held throws
 * `Duplicate key`, the batch is restored to the head of the ring, and every
 * later row for the table is stuck behind it until the failure limit trips.
 */
import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { LOCAL_SCHEMAS } from '../../__tests__/packs/legacy-tables'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { HybridDuckDB } from '../../core/engine'
import { SensorBuffer } from '../buffer'
import { BatchFlusher } from '../flusher'
import { OverflowStore } from '../overflow'

const TENANT = { brand: 'acme', familyId: 'fam_1', userId: 'u1', deviceId: 'ring_1' }

async function rig() {
  const db = new HybridDuckDB(() => createRealDuckDB([]))
  await db.open()
  await db.execute(LOCAL_SCHEMAS.sleep_session)
  const cols = await db.execute<{ column_name: string }>(
    `SELECT column_name FROM duckdb_columns() WHERE table_name = 'sleep_session' ORDER BY column_index`,
  )
  const buffer = new SensorBuffer({ overflow: new OverflowStore(createFakeKV().kv) })
  const flusher = new BatchFlusher({ engine: db, buffer, columnOrder: { sleep_session: cols.map(c => c.column_name) } })
  return { db, buffer, flusher }
}

function session(id: string, startIso: string, nightOf: Date) {
  const start = new Date(startIso)
  return {
    session_id: id,
    ts_start: start,
    ts_end: new Date(start.getTime() + 7 * 3600_000),
    brand: TENANT.brand,
    family_id: TENANT.familyId,
    user_id: TENANT.userId,
    device_id: TENANT.deviceId,
    total_minutes: 420,
    night_of: nightOf,
  }
}

async function flushOne(r: Awaited<ReturnType<typeof rig>>, row: Record<string, unknown>) {
  await r.buffer.push({ table: 'sleep_session', ...TENANT, rows: [row] })
  try {
    await r.flusher.flush('sleep_session', 'manual')
  }
  catch {
    // A throwing flush is itself the defect; the assertions below say which.
  }
}

describe('self-keyed tables flush idempotently', () => {
  it('a re-synced sleep_session row neither throws nor blocks the rows behind it', async () => {
    const r = await rig()
    const night = new Date(Date.UTC(2026, 5, 17))
    await flushOne(r, session('s1', '2026-06-17T22:00:00Z', night))
    await flushOne(r, session('s1', '2026-06-17T22:00:00Z', night)) // re-sync: same id
    await flushOne(r, session('s2', '2026-06-18T22:00:00Z', new Date(Date.UTC(2026, 5, 18))))
    const ids = await r.db.execute<{ session_id: string }>(`SELECT session_id FROM sleep_session ORDER BY session_id`)
    expect(ids.map(x => x.session_id)).toEqual(['s1', 's2'])
    await r.db.close()
  })
})

describe('rows inserted vs rows drained (app#460 P17)', () => {
  it('reports 0 inserted for a re-sync of a row already held, and leaves it out of insertedTables', async () => {
    const r = await rig()
    const night = new Date(Date.UTC(2026, 5, 17))
    const row = session('s1', '2026-06-17T22:00:00Z', night)

    await r.buffer.push({ table: 'sleep_session', ...TENANT, rows: [row] })
    const first = await r.flusher.flush('sleep_session', 'manual')
    expect(first).toMatchObject({ rowsFlushed: 1, rowsInserted: 1 })

    const batchId = r.flusher.beginBatch('manual')
    await r.buffer.push({ table: 'sleep_session', ...TENANT, rows: [row] })
    const again = await r.flusher.flush('sleep_session', 'manual', batchId)
    expect(again).toMatchObject({ rowsFlushed: 1, rowsInserted: 0 })

    const batch = r.flusher.endBatch(batchId)
    expect(batch?.affectedTables).toEqual(['sleep_session'])
    expect(batch?.insertedTables).toEqual([])
    await r.db.close()
  })
})

describe('a DATE column keeps the calendar date it was given', () => {
  // The flusher writes a JS Date bound for a DATE column as that UTC date,
  // whatever the process zone: no shift across midnight, month or year.
  it.each([
    [Date.UTC(2026, 5, 17), '2026-06-17'],
    [Date.UTC(2026, 0, 1), '2026-01-01'],
    [Date.UTC(2025, 11, 31), '2025-12-31'],
  ])('%s → %s', async (ms, expected) => {
    const r = await rig()
    await flushOne(r, session(`d_${expected}`, '2026-06-17T20:00:00Z', new Date(ms)))
    const rows = await r.db.execute<{ d: string }>(`SELECT CAST(night_of AS VARCHAR) AS d FROM sleep_session`)
    expect(rows.map(x => x.d)).toEqual([expected])
    await r.db.close()
  })
})
