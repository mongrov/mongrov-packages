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
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { HybridDuckDB } from '../../core/engine'
import { LOCAL_SCHEMAS } from '../../core/schemas'
import { SensorBuffer } from '../buffer'
import { BatchFlusher } from '../flusher'
import { computeNightOf } from '../mapper/time'
import { OverflowStore } from '../overflow'

const TENANT = { brand: 'ziva', familyId: 'fam_1', userId: 'u1', deviceId: 'ring_1' }

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

describe('night_of survives the write as the local evening date', () => {
  // 01:30 IST on Jun 18 is 20:00 UTC on Jun 17: the night of Jun 17.
  it.each([
    ['Asia/Kolkata', '2026-06-17T20:00:00Z'],
    ['America/Los_Angeles', '2026-06-18T08:30:00Z'],
    ['UTC', '2026-06-18T01:30:00Z'],
  ])('%s', async (tz, iso) => {
    const r = await rig()
    await flushOne(r, session(`n_${tz}`, iso, computeNightOf(new Date(iso), tz)))
    const rows = await r.db.execute<{ d: string }>(`SELECT CAST(night_of AS VARCHAR) AS d FROM sleep_session`)
    expect(rows.map(x => x.d)).toEqual(['2026-06-17'])
    await r.db.close()
  })
})
