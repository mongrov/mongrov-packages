/**
 * Derived sleep inside a batch (sleep-correction §3), on a real DuckDB with
 * the real buffer, flusher and warehouse DDL.
 *
 * The contract: raw minutes flush, the correction pipeline runs over them,
 * and the corrected nights land in the SAME batch — so `batch:complete`
 * follows them. Re-correcting a night replaces it (principle 66 as amended)
 * and never touches its neighbours.
 */
import type { FirmwareActivityRow, FirmwareSleepRawRow, MapperContext } from '../mapper/types'

import { describe, expect, it, vi } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { HybridDuckDB } from '../../core/engine'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../core/schemas'
import { SensorBuffer } from '../buffer'
import { BatchFlusher } from '../flusher'
import { mapActivity } from '../mapper/activity'
import { mapSleepRaw } from '../mapper/sleep'
import { OverflowStore } from '../overflow'
import { createSleepDeriver } from '../sleep-derive'

const TENANT = { brand: 'ziva', familyId: 'fam_1', userId: 'u1', deviceId: 'ring_1' }
const CTX: MapperContext = { ...TENANT, userTimezone: 'UTC' }
const TABLES = ['sleep_raw', 'sleep_session', 'sleep_stage', 'heart_rate', 'activity', 'activity_bucket'] as const
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

async function rig(opts: {
  resolveTimezone?: () => Promise<string>
  hrWindows?: readonly (readonly [string, string])[]
  now?: number
  logger?: { debug: () => void, info: () => void, warn: () => void, error: () => void }
} = {}) {
  const db = new HybridDuckDB(() => createRealDuckDB([]))
  await db.open()
  for (const t of TABLES) await db.execute(LOCAL_SCHEMAS[t])
  for (const t of ['heart_rate', 'activity', 'activity_bucket'] as const)
    await db.execute(generateViewDdl(t, { brand: TENANT.brand, familyId: TENANT.familyId, localCatalog: 'memory' }))

  const columnOrder: Record<string, string[]> = {}
  for (const t of TABLES) {
    const cols = await db.execute<{ column_name: string }>(
      `SELECT column_name FROM duckdb_columns() WHERE table_name = '${t}' ORDER BY column_index`,
    )
    columnOrder[t] = cols.map(c => c.column_name)
  }

  // Sleeping-level HR through the nights under test, so the pipeline has a
  // tier, percentiles and envelope samples.
  const hr: string[] = []
  for (const [from, to] of opts.hrWindows ?? [['2026-06-17T22:00:00', '2026-06-18T07:00:00'], ['2026-06-18T22:00:00', '2026-06-19T07:00:00']]) {
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
    now: () => opts.now ?? at('2026-06-20T00:00:00'),
    logger: opts.logger,
  })

  /** One sync: raw rows (and any activity) in, flush, derive, close the batch. */
  async function sync(rows: FirmwareSleepRawRow[], extra: { activity?: FirmwareActivityRow[] } = {}) {
    const raw = mapSleepRaw(rows, CTX) as unknown as Record<string, unknown>[]
    if (raw.length > 0) {
      await buffer.push({ table: 'sleep_raw', ...TENANT, rows: raw })
      deriver.noteRaw({ ...TENANT, rows: raw })
    }
    if (extra.activity?.length) {
      const mapped = mapActivity(extra.activity, CTX)
      await buffer.push({ table: 'activity', ...TENANT, rows: mapped.activity as unknown as Record<string, unknown>[] })
      await buffer.push({ table: 'activity_bucket', ...TENANT, rows: mapped.activity_bucket as unknown as Record<string, unknown>[] })
    }
    const batchId = flusher.beginBatch('manual')
    for (const t of ['activity', 'activity_bucket', 'sleep_raw'] as const)
      await flusher.flush(t, 'manual', batchId)
    await deriver.derive(batchId, 'manual')
    return flusher.endBatch(batchId)
  }

  async function sessions() {
    return db.execute<{ session_id: string, night: string, end: string, total_minutes: number, settle_min: number | null, recovered_min: number | null }>(
      `SELECT session_id, CAST(night_of AS VARCHAR) AS night, CAST(ts_end AS VARCHAR) AS "end", total_minutes, settle_min, recovered_min
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

describe('a replace that fails part-way', () => {
  it('writes the nights already replaced, leaves later nights alone, and says so', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const r = await rig({ logger })
    await r.sync([...rawNight('2026-06-17T23:00:00', 300), ...rawNight('2026-06-18T23:00:00', 300)])
    const [, night2] = await r.sessions()

    // Both nights re-derive; the second night's first delete throws, after
    // night 1's stored rows were already deleted.
    const execute = r.db.execute.bind(r.db)
    r.db.execute = (async (sql: string, params?: Record<string, unknown>) => {
      if (sql.includes('DELETE FROM memory.main.sleep_stage') && params?.night === night2.night)
        throw new Error('disk I/O error')
      return execute(sql, params)
    }) as typeof r.db.execute
    await r.sync([
      ...rawNight('2026-06-18T04:00:00', 60, '2026-06-17T23:00:00'),
      ...rawNight('2026-06-19T04:00:00', 60, '2026-06-18T23:00:00'),
    ])

    const after = await r.sessions()
    expect(after).toHaveLength(2)
    expect(after[0].night).toBe('2026-06-17')
    expect(after[0].total_minutes).toBeGreaterThan(300) // the corrected night 1 was written, not lost
    expect(after[1]).toEqual(night2) // night 2 untouched
    expect(logger.error).toHaveBeenCalledWith(
      'sync.sleep-derive: correction stopped part-way; stopped night may be missing rows',
      expect.objectContaining({ nightsReplaced: 1, stoppedAt: expect.any(String) }),
    )
    await r.db.close()
  }, 60_000)
})

describe('a capture split across syncs', () => {
  it('two delta syncs land the same night as one sync of the whole capture', async () => {
    // The acceptance case for staging + night replace (§3): a ring that syncs
    // twice mid-night must not end up with two half nights, or with a night
    // that differs from the one a single sync would have produced.
    const whole = rawNight('2026-06-17T23:00:00', 300)

    const single = await rig()
    await single.sync(whole)
    const once = await single.sessions()
    await single.db.close()

    const split = await rig()
    await split.sync(whole.slice(0, 150))
    await split.sync(whole.slice(150))
    const twice = await split.sessions()
    const stages = await split.stageCount()
    await split.db.close()

    expect(twice).toHaveLength(1)
    expect(twice).toEqual(once)
    expect(stages).toBe(twice[0].total_minutes)
  }, 120_000)
})

describe('the night before a batch is re-derived (v1 parity, ruled 2026-10-28)', () => {
  it('a morning sync cannot trim the END; the next sync, carrying the day\'s steps, can', async () => {
    // Sleeping HR until 02:55, then nothing until the waking samples below.
    const r = await rig({ hrWindows: [['2026-06-17T22:00:00', '2026-06-18T02:55:00'], ['2026-06-18T22:00:00', '2026-06-19T07:00:00']] })
    // Firmware scores light sleep until 03:59, but HR is at waking level
    // from 03:00: the wearer was up, the firmware had not caught up.
    const awake: string[] = []
    for (let t = at('2026-06-18T03:00:00'); t <= at('2026-06-18T03:55:00'); t += 300_000)
      awake.push(`('${ts(t)}', 'ziva', 'fam_1', 'u1', 'ring_1', 90)`)
    await r.db.execute(`INSERT INTO heart_rate (ts, brand, family_id, user_id, device_id, bpm) VALUES ${awake.join(',')}`)

    // Morning sync: night 1's minutes, no steps yet. Step 5.6 wants ≥ 150
    // steps after the wake it sees, so the END stays at the last firmware minute.
    await r.sync(rawNight('2026-06-17T23:00:00', 300))
    const [morning] = await r.sessions()
    expect(morning.night).toBe('2026-06-17')
    expect(morning.end).toBe('2026-06-18 04:00:00')

    // Evening sync: night 2's minutes and the day's activity — 200 steps in
    // the 03:10 bucket. The new sleep rows span night 2 only; night 1 is
    // re-derived because it is the night before.
    await r.sync(rawNight('2026-06-18T23:00:00', 300), {
      activity: [{ timestamp: fw(at('2026-06-18T03:10:00')), step: 200, calories: 1, distance: 0, arraySteps: [20, 20, 20, 20, 20, 20, 20, 20, 20, 20] }],
    })
    const after = await r.sessions()
    expect(after.map(s => s.night)).toEqual(['2026-06-17', '2026-06-18'])
    // Night 1's END moved back to the last asleep HR sample (02:55) + 1 min,
    // so its principle-25 id moved and the morning's row is gone.
    expect(after[0].end).toBe('2026-06-18 02:56:00')
    expect(after[0].session_id).not.toBe(morning.session_id)
    expect(after[0].total_minutes).toBe(morning.total_minutes - 64)
    expect(after[1].end).toBe('2026-06-19 06:00:00') // night 2: extended on sleeping HR, as the first test
    expect(await r.stageCount()).toBe(after[0].total_minutes + after[1].total_minutes)
    await r.db.close()
  }, 60_000)
})

describe('DST — the night window comes from the IANA offset', () => {
  it('keeps the fall-back night whole, and names it by its evening', async () => {
    // Los Angeles falls back 2025-11-02 02:00 → 01:00, so that local night is
    // 25 hours long and 01:30 happens twice. A fixed offset would either split
    // the night or drop the repeated hour; the offset is read at 18:00 local
    // on the night's own evening.
    const r = await rig({
      resolveTimezone: async () => 'America/Los_Angeles',
      hrWindows: [['2025-11-02T04:00:00', '2025-11-02T15:00:00']],
      now: at('2025-11-04T00:00:00'),
    })
    // 23:00 PDT on the 1st = 06:00 UTC on the 2nd; 300 minutes of it spans
    // both passes of 01:00-01:59 local.
    await r.sync(rawNight('2025-11-02T06:00:00', 300))

    const s = await r.sessions()
    expect(s).toHaveLength(1)
    expect(s[0].night).toBe('2025-11-01') // the evening the night began
    expect(s[0].total_minutes).toBeGreaterThanOrEqual(300)
    expect(await r.stageCount()).toBe(s[0].total_minutes)
    await r.db.close()
  }, 120_000)
})
