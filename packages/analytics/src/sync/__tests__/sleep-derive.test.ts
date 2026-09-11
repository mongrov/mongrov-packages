/**
 * Derived sleep inside a batch (sleep-correction §3), on a real DuckDB with
 * the real buffer, flusher and warehouse DDL.
 *
 * The contract: raw minutes flush, the correction pipeline runs over them,
 * and the corrected nights land in the SAME batch — so `batch:complete`
 * follows them. Re-correcting a night replaces it (principle 66 as amended)
 * and never touches its neighbours.
 */
import type { FirmwareSleepRawRow, MapperContext } from '../mapper/types'

import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { HybridDuckDB } from '../../core/engine'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../core/schemas'
import { SensorBuffer } from '../buffer'
import { BatchFlusher } from '../flusher'
import { mapSleepRaw } from '../mapper/sleep'
import { OverflowStore } from '../overflow'
import { createSleepDeriver } from '../sleep-derive'

const TENANT = { brand: 'ziva', familyId: 'fam_1', userId: 'u1', deviceId: 'ring_1' }
const CTX: MapperContext = { ...TENANT, userTimezone: 'UTC' }
const TABLES = ['sleep_raw', 'sleep_session', 'sleep_stage', 'heart_rate', 'activity'] as const
const DASH_RE = /-/g

const at = (iso: string) => Date.parse(`${iso}Z`)
const fw = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ').replace(DASH_RE, '.')
const ts = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

/** `minutes` raw light-sleep samples from `from`, one firmware session. */
function rawNight(from: string, minutes: number, sessionStart = from): FirmwareSleepRawRow[] {
  const s = at(from)
  return Array.from({ length: minutes }, (_, i) => ({
    timestamp: fw(s + i * 60_000),
    quality: 2,
    start: fw(at(sessionStart)),
    unitLength: 1,
  }))
}

async function rig(opts: { resolveTimezone?: () => Promise<string> } = {}) {
  const db = new HybridDuckDB(() => createRealDuckDB([]))
  await db.open()
  for (const t of TABLES) await db.execute(LOCAL_SCHEMAS[t])
  for (const t of ['heart_rate', 'activity'] as const)
    await db.execute(generateViewDdl(t, { brand: TENANT.brand, familyId: TENANT.familyId, localCatalog: 'memory' }))

  const columnOrder: Record<string, string[]> = {}
  for (const t of TABLES) {
    const cols = await db.execute<{ column_name: string }>(
      `SELECT column_name FROM duckdb_columns() WHERE table_name = '${t}' ORDER BY column_index`,
    )
    columnOrder[t] = cols.map(c => c.column_name)
  }

  // Sleeping-level HR through both nights, so the pipeline has a tier,
  // percentiles and envelope samples.
  const hr: string[] = []
  for (const [from, to] of [['2026-06-17T22:00:00', '2026-06-18T07:00:00'], ['2026-06-18T22:00:00', '2026-06-19T07:00:00']]) {
    for (let t = at(from); t <= at(to); t += 300_000)
      hr.push(`('${ts(t)}', 'ziva', 'fam_1', 'u1', 'ring_1', 60)`)
  }
  await db.execute(`INSERT INTO heart_rate (ts, brand, family_id, user_id, device_id, bpm) VALUES ${hr.join(',')}`)

  const buffer = new SensorBuffer({ overflow: new OverflowStore(createFakeKV().kv) })
  const flusher = new BatchFlusher({ engine: db, buffer, columnOrder })
  const deriver = createSleepDeriver({
    engine: db,
    buffer,
    flusher,
    resolveTimezone: opts.resolveTimezone ?? (async () => 'UTC'),
    now: () => at('2026-06-20T00:00:00'),
  })

  /** One sync: raw rows in, flush, derive, close the batch. */
  async function sync(rows: FirmwareSleepRawRow[]) {
    const raw = mapSleepRaw(rows, CTX) as unknown as Record<string, unknown>[]
    if (raw.length > 0) {
      await buffer.push({ table: 'sleep_raw', ...TENANT, rows: raw })
      deriver.noteRaw({ ...TENANT, rows: raw })
    }
    const batchId = flusher.beginBatch('manual')
    await flusher.flush('sleep_raw', 'manual', batchId)
    await deriver.derive(batchId, 'manual')
    return flusher.endBatch(batchId)
  }

  async function sessions() {
    return db.execute<{ session_id: string, night: string, total_minutes: number, settle_min: number | null, recovered_min: number | null }>(
      `SELECT session_id, CAST(night_of AS VARCHAR) AS night, total_minutes, settle_min, recovered_min
       FROM sleep_session ORDER BY ts_start`,
    )
  }
  async function stageCount() {
    const [r] = await db.execute<{ n: number }>(`SELECT CAST(count(*) AS INTEGER) AS n FROM sleep_stage`)
    return r.n
  }

  return { db, deriver, sync, sessions, stageCount }
}

describe('sleep derive inside the batch', () => {
  it('writes the corrected night into the same batch that flushed the raw minutes', async () => {
    const r = await rig()
    const done = await r.sync(rawNight('2026-06-17T23:00:00', 300))

    expect(done?.affectedTables).toEqual(expect.arrayContaining(['sleep_raw', 'sleep_session', 'sleep_stage']))
    const s = await r.sessions()
    expect(s).toHaveLength(1)
    expect(s[0].night).toBe('2026-06-17') // the evening the night began
    expect(s[0].total_minutes).toBeGreaterThanOrEqual(300) // extended on sleeping HR
    expect(s[0].settle_min).toBe(0) // HR already at its night low at bed
    expect(s[0].recovered_min).toBeGreaterThan(0)
    expect(await r.stageCount()).toBe(s[0].total_minutes)
    expect(r.deriver.pendingCount()).toBe(0)
    await r.db.close()
  }, 60_000)

  it('replaces a re-corrected night and leaves the next night alone', async () => {
    const r = await rig()
    await r.sync([...rawNight('2026-06-17T23:00:00', 300), ...rawNight('2026-06-18T23:00:00', 300)])
    const [night1, night2] = await r.sessions()
    expect([night1.night, night2.night]).toEqual(['2026-06-17', '2026-06-18'])

    // A later sync delivers more of night 1 only. Night 1's END moves, so its
    // principle-25 id moves — it must be REPLACED, not appended to. Night 2's
    // night_of equals night 1's MORNING date, which a delete keyed on v3.1's
    // morning-named night would wipe.
    await r.sync(rawNight('2026-06-18T04:00:00', 60, '2026-06-17T23:00:00'))
    const after = await r.sessions()
    expect(after).toHaveLength(2)
    expect(after[0].night).toBe('2026-06-17')
    expect(after[0].session_id).not.toBe(night1.session_id)
    expect(after[0].total_minutes).toBeGreaterThan(night1.total_minutes)
    expect(after[1]).toEqual(night2)
    expect(await r.stageCount()).toBe(after[0].total_minutes + after[1].total_minutes)
    await r.db.close()
  }, 60_000)

  it('does nothing when no raw sleep is pending', async () => {
    const r = await rig()
    const done = await r.sync([])
    expect(done).toBeNull() // nothing flushed ⇒ no batch-complete
    expect(await r.sessions()).toEqual([])
    await r.db.close()
  }, 60_000)

  it('never throws: a failed correction keeps the raw minutes and the batch closes', async () => {
    const r = await rig({ resolveTimezone: async () => { throw new Error('profile unavailable') } })
    const done = await r.sync(rawNight('2026-06-17T23:00:00', 300))
    expect(done?.affectedTables).toEqual(['sleep_raw'])
    expect(await r.sessions()).toEqual([])
    await r.db.close()
  }, 60_000)
})
