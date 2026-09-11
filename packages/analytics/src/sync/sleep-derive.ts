/**
 * Derived sleep — the correction step every batch cycle runs before
 * `batch:complete` (sleep-correction §3).
 *
 * `sleep_raw` is written like any sensor table. Sessions and stages are not:
 * they are derived from it by the validated correction pipeline, night by
 * night, and written back into the SAME batch, so a `context: 'asleep'` rule
 * woken by `batch:complete` sees corrected sleep, never raw minutes.
 *
 * Raw rows can arrive by three flush paths (scheduled cycle, manual flush,
 * size/age triggers), so the deriver does not hang off any one flush: it
 * notes every enqueued `sleep_raw` range, and the next batch cycle corrects
 * all pending nights after its flushes land.
 *
 * Night replace (principle 66 as amended): a corrected night's END moves as
 * later data arrives, and the principle-25 id moves with it, so a night is
 * DELETEd locally before its new rows are written. Nights that come back with
 * no primary block are left alone — replacing a night with nothing on a
 * partial sync would erase sleep the next sync restores.
 *
 * Local only. Rows already pushed to a remote catalog are not rewritten; that
 * needs a server-side answer before cloud sync is switched on.
 */

import type { HybridDuckDB } from '../core/engine'
import type { SensorBuffer } from './buffer'
import type { BatchFlusher, FlushReason } from './flusher'
import type { MapperContext, SleepSessionRow, SleepStageRow } from './mapper/types'
import type { SchedulerLogger } from './scheduler'
import type { SqlRunner } from './sleep-correction/correct'

import { sessionsFromCorrected } from './mapper/sleep'
import { computeNightOf } from './mapper/time'
import { correctSleepNights, nightsForEpochs } from './sleep-correction/orchestrate'
import { stagingViewsSql } from './sleep-correction/staging'

interface PendingRange {
  brand: string
  familyId: string
  userId: string
  deviceId: string
  minEpoch: number
  maxEpoch: number
}

export interface SleepDeriverDeps {
  engine: HybridDuckDB
  buffer: SensorBuffer
  flusher: BatchFlusher
  /** The user's IANA zone (the factory's `resolveTimezone`). */
  resolveTimezone: (userId: string) => Promise<string>
  /** Baseline lookback. v3.1 production: 30 days. */
  lookbackDays?: number
  now?: () => number
  logger?: SchedulerLogger
  localCatalog?: string
}

export interface SleepDeriver {
  /** Record an enqueued `sleep_raw` batch so the next cycle corrects its nights. */
  noteRaw: (batch: {
    brand: string
    familyId: string
    userId: string
    deviceId: string
    rows: ReadonlyArray<Record<string, unknown>>
  }) => void
  /** (user, device) ranges still waiting for a cycle. */
  pendingCount: () => number
  /** Correct every pending range and write its nights into `batchId`. Never throws. */
  derive: (batchId: string, reason: FlushReason) => Promise<void>
}

const SIX_HOURS = 6 * 3600

function epochOf(ts: unknown): number | null {
  if (ts instanceof Date)
    return Math.floor(ts.getTime() / 1000)
  if (typeof ts === 'number')
    return Math.floor(ts > 1e12 ? ts / 1000 : ts)
  if (typeof ts === 'string') {
    const ms = Date.parse(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`)
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
  }
  return null
}

/** The `night_of` value a session starting inside this window is stored with. */
function storedNightOf(windowStart: number, timeZone: string): string {
  return computeNightOf(new Date((windowStart + 60) * 1000), timeZone).toISOString().slice(0, 10)
}

/** Every 6pm→6pm night between two instants, inclusive. */
function nightsBetween(minEpoch: number, maxEpoch: number, timeZone: string): string[] {
  const probes: number[] = []
  for (let e = minEpoch; e < maxEpoch; e += SIX_HOURS) probes.push(e)
  probes.push(maxEpoch)
  return nightsForEpochs(probes, timeZone)
}

function DELETE_STAGES_SQL(catalog: string) {
  return `
DELETE FROM ${catalog}.main.sleep_stage
WHERE session_id IN (
  SELECT session_id FROM ${catalog}.main.sleep_session
  WHERE brand = $brand AND family_id = $family_id AND user_id = $user_id
    AND device_id = $device_id AND night_of = CAST($night AS DATE)
)`
}

function DELETE_SESSIONS_SQL(catalog: string) {
  return `
DELETE FROM ${catalog}.main.sleep_session
WHERE brand = $brand AND family_id = $family_id AND user_id = $user_id
  AND device_id = $device_id AND night_of = CAST($night AS DATE)`
}

export function createSleepDeriver(deps: SleepDeriverDeps): SleepDeriver {
  const pending = new Map<string, PendingRange>()
  const catalog = deps.localCatalog ?? 'memory'
  const now = deps.now ?? (() => Date.now())
  const lookbackDays = deps.lookbackDays ?? 30

  async function replaceNight(ctx: MapperContext, night: string): Promise<void> {
    const params = {
      brand: ctx.brand,
      family_id: ctx.familyId,
      user_id: ctx.userId,
      device_id: ctx.deviceId,
      night,
    }
    await deps.engine.execute(DELETE_STAGES_SQL(catalog), params)
    await deps.engine.execute(DELETE_SESSIONS_SQL(catalog), params)
  }

  async function deriveRange(p: PendingRange): Promise<{ sessions: SleepSessionRow[], stages: SleepStageRow[] }> {
    const timeZone = await deps.resolveTimezone(p.userId)
    const ctx: MapperContext = {
      brand: p.brand,
      familyId: p.familyId,
      userId: p.userId,
      deviceId: p.deviceId,
      userTimezone: timeZone,
    }
    for (const sql of stagingViewsSql({ ...ctx, localCatalog: catalog }))
      await deps.engine.execute(sql)

    const result = await correctSleepNights(deps.engine as unknown as SqlRunner, {
      nights: nightsBetween(p.minEpoch, p.maxEpoch, timeZone),
      timeZone,
      cutoffEpoch: Math.floor(now() / 1000) - lookbackDays * 86400,
    })

    const sessions: SleepSessionRow[] = []
    const stages: SleepStageRow[] = []
    for (const n of result.nights) {
      if (n.status === 'failed')
        deps.logger?.warn('sync.sleep-derive: night failed; previous rows kept', { night: n.night, err: n.error })
      if (n.status !== 'ok' || !n.rows)
        continue
      const out = sessionsFromCorrected(n.rows, ctx, { settleMin: n.settleMin })
      if (out.sleep_session.length === 0)
        continue
      // Two conventions meet here. v3.1 names a night by its MORNING date
      // (window Jun 17 18:00 → Jun 18 18:00 is "2026-06-18"); `night_of` is
      // the mapper's evening date, stored as the UTC date of `computeNightOf`.
      // Deleting by `n.night` would wipe the FOLLOWING night — so the key is
      // derived exactly as the writer derives it, from inside the window.
      const nights = new Set([
        storedNightOf(n.windowStart, timeZone),
        ...out.sleep_session.map(s => s.night_of.toISOString().slice(0, 10)),
      ])
      for (const night of nights)
        await replaceNight(ctx, night)
      sessions.push(...out.sleep_session)
      stages.push(...out.sleep_stage)
    }
    return { sessions, stages }
  }

  return {
    noteRaw(batch) {
      let min = Number.POSITIVE_INFINITY
      let max = Number.NEGATIVE_INFINITY
      for (const row of batch.rows) {
        const e = epochOf(row.ts)
        if (e == null)
          continue
        if (e < min)
          min = e
        if (e > max)
          max = e
      }
      if (!Number.isFinite(min))
        return
      const key = `${batch.brand}|${batch.familyId}|${batch.userId}|${batch.deviceId}`
      const prev = pending.get(key)
      pending.set(key, {
        brand: batch.brand,
        familyId: batch.familyId,
        userId: batch.userId,
        deviceId: batch.deviceId,
        minEpoch: prev ? Math.min(prev.minEpoch, min) : min,
        maxEpoch: prev ? Math.max(prev.maxEpoch, max) : max,
      })
    },

    pendingCount: () => pending.size,

    async derive(batchId, reason) {
      if (pending.size === 0)
        return
      const ranges = [...pending.values()]
      pending.clear()
      for (const p of ranges) {
        try {
          const { sessions, stages } = await deriveRange(p)
          const tenant = { brand: p.brand, familyId: p.familyId, userId: p.userId, deviceId: p.deviceId }
          if (sessions.length > 0)
            await deps.buffer.push({ table: 'sleep_session', ...tenant, rows: sessions as unknown as Record<string, unknown>[] })
          if (stages.length > 0)
            await deps.buffer.push({ table: 'sleep_stage', ...tenant, rows: stages as unknown as Record<string, unknown>[] })
        }
        catch (err) {
          deps.logger?.warn('sync.sleep-derive: correction failed; raw sleep kept, nights unchanged', {
            userId: p.userId,
            deviceId: p.deviceId,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
      // Land the derived rows inside this batch, so batch:complete follows them.
      await deps.flusher.flush('sleep_session', reason, batchId)
      await deps.flusher.flush('sleep_stage', reason, batchId)
    },
  }
}
