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
 * The night BEFORE a batch is re-derived too (ruled 2026-10-28). v1 recomputed
 * every calendar day from the first new sleep chunk's date through today
 * (ziva_app `AppContextProvider.tsx:1006-1029`), so a night first corrected
 * by a morning sync — before the day's steps and waking HR had arrived — was
 * corrected again at the next sync, when Step 5.6 (≥ 150 steps after the
 * wake it sees) could trim an END the morning could not. The nights a batch's
 * own `sleep_raw` rows span would miss that, so `nightsBetween` prepends the
 * night before the earliest one, in every zone. A preceding night with no
 * firmware sleep comes back `no_firmware_sleep` and its stored rows stay, as
 * above.
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
import type { FlushResult } from './types'

import { describeError } from '../core/errors'
import { tailId } from '../core/logger'
import { sessionsFromCorrected } from './mapper/sleep'
import { computeNightOf } from './mapper/time'
import { logError } from './scheduler'
import { correctSleepNights, nightsForEpochs, stagingBoundsFor } from './sleep-correction/orchestrate'
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
  /**
   * Step relation for Step 5.6 (`staging.ts`): the firmware's 10-minute
   * bucket totals, as v3.1 (`'bucket'`, default), or the 1-minute rows when
   * `activity_bucket` is not subscribed (`'minute'`; the factory warns once).
   */
  activitySteps?: 'bucket' | 'minute'
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
  /**
   * Correct every pending range and write its nights into `batchId`. Never
   * throws. Resolves with the `sleep_session` / `sleep_stage` flush results
   * (empty when nothing was pending), so a caller's flush summary counts the
   * derived rows — they are buffered and flushed here, after the caller's own
   * per-table flushes, which drained those tables while they were still
   * empty (zivaone_app#452: the handoff logged `sleep_session: 0` on a sync
   * that derived 20 sessions).
   */
  derive: (batchId: string, reason: FlushReason) => Promise<FlushResult[]>
}

const SIX_HOURS = 6 * 3600
const QUOTE_RE = /'/g

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

/** The night before an ISO night (calendar arithmetic; nights are dates, not instants). */
function previousNight(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

/**
 * Every 6pm→6pm night between two instants, inclusive, plus the night before
 * the first — the one a previous sync may have corrected without the day's
 * steps and waking HR (see the header). Sorted, as `nightsForEpochs` is.
 */
function nightsBetween(minEpoch: number, maxEpoch: number, timeZone: string): string[] {
  const probes: number[] = []
  for (let e = minEpoch; e < maxEpoch; e += SIX_HOURS) probes.push(e)
  probes.push(maxEpoch)
  const nights = nightsForEpochs(probes, timeZone)
  if (nights.length > 0) {
    const before = previousNight(nights[0])
    if (!nights.includes(before))
      nights.unshift(before)
  }
  return nights
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

  /**
   * Re-key stored `night_of` to what `computeNightOf` says today.
   *
   * Rows written before 0.25.1 carry the old value — a day early east of UTC
   * — and nights outside this sync's range are never re-derived, so without
   * this they would stay wrong, and a replace keyed on the corrected night
   * would miss them. Idempotent: once keys agree it only reads. Computed in
   * JS through the one `computeNightOf`, not in SQL, so it needs no ICU.
   */
  async function rekeyNights(ctx: MapperContext): Promise<void> {
    const rows = await deps.engine.execute<{ session_id: string, e: number | bigint, night: string }>(
      `SELECT session_id, CAST(epoch(ts_start) AS BIGINT) AS e, CAST(night_of AS VARCHAR) AS night
       FROM ${catalog}.main.sleep_session
       WHERE brand = $brand AND family_id = $family_id AND user_id = $user_id AND device_id = $device_id`,
      { brand: ctx.brand, family_id: ctx.familyId, user_id: ctx.userId, device_id: ctx.deviceId },
    )
    for (const r of rows) {
      const want = computeNightOf(new Date(Number(r.e) * 1000), ctx.userTimezone).toISOString().slice(0, 10)
      if (want === r.night)
        continue
      await deps.engine.execute(
        `UPDATE ${catalog}.main.sleep_session SET night_of = CAST($night AS DATE) WHERE session_id = $id`,
        { night: want, id: r.session_id },
      )
    }
  }

  /**
   * Drop any stored session sharing an id with a row about to be written.
   * Keyed flushes are ON CONFLICT DO NOTHING, so a stale row with the same id
   * would otherwise silently win over the corrected one.
   */
  async function deleteByIds(ids: readonly string[]): Promise<void> {
    if (ids.length === 0)
      return
    const list = ids.map(id => `'${id.replace(QUOTE_RE, '\'\'')}'`).join(', ')
    await deps.engine.execute(`DELETE FROM ${catalog}.main.sleep_stage WHERE session_id IN (${list})`)
    await deps.engine.execute(`DELETE FROM ${catalog}.main.sleep_session WHERE session_id IN (${list})`)
  }

  interface DerivedRange {
    sessions: SleepSessionRow[]
    stages: SleepStageRow[]
    nights: number
    failedNights: string[]
    firstNightError?: string
    /**
     * Set when replacing a night's stored rows threw. The `nightsReplaced`
     * nights before it were already deleted, so their corrected rows must
     * still be written; later nights were never touched.
     */
    stopped?: { night: string, nightsReplaced: number, error: unknown }
  }

  async function deriveRange(p: PendingRange): Promise<DerivedRange> {
    const timeZone = await deps.resolveTimezone(p.userId)
    const ctx: MapperContext = {
      brand: p.brand,
      familyId: p.familyId,
      userId: p.userId,
      deviceId: p.deviceId,
      userTimezone: timeZone,
    }
    await rekeyNights(ctx)
    const input = {
      nights: nightsBetween(p.minEpoch, p.maxEpoch, timeZone),
      timeZone,
      cutoffEpoch: Math.floor(now() / 1000) - lookbackDays * 86400,
    }
    // Bounded to what this run reads, so the views prune on `ts` (#460).
    for (const sql of stagingViewsSql({ ...ctx, localCatalog: catalog, activitySteps: deps.activitySteps }, undefined, stagingBoundsFor(input)))
      await deps.engine.execute(sql)

    const result = await correctSleepNights(deps.engine as unknown as SqlRunner, input)

    const sessions: SleepSessionRow[] = []
    const stages: SleepStageRow[] = []
    // Collected and logged once per range: a backfill spans weeks of nights,
    // and a sick query fails every one of them identically.
    const failedNights: string[] = []
    let firstNightError: string | undefined
    let nightsReplaced = 0
    for (const n of result.nights) {
      if (n.status === 'failed') {
        failedNights.push(n.night)
        firstNightError ??= n.error
      }
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
      try {
        for (const night of nights)
          await replaceNight(ctx, night)
        await deleteByIds(out.sleep_session.map(s => s.session_id))
      }
      catch (error) {
        // Stop: the nights before this one are already deleted, so what was
        // collected for them is returned and still written. This night may
        // have lost some stored rows; writing its corrected ones now could
        // duplicate the ones that survived, so it waits for the next sync.
        return { sessions, stages, nights: result.nights.length, failedNights, firstNightError, stopped: { night: n.night, nightsReplaced, error } }
      }
      nightsReplaced += 1
      sessions.push(...out.sleep_session)
      stages.push(...out.sleep_stage)
    }
    return { sessions, stages, nights: result.nights.length, failedNights, firstNightError }
  }

  function logRange(p: PendingRange, d: DerivedRange): void {
    if (d.failedNights.length === 0)
      return
    deps.logger?.warn('sync.sleep-derive: nights failed; previous rows kept', {
      deviceId: tailId(p.deviceId),
      failed: d.failedNights.length,
      nights: d.failedNights.slice(0, 10),
      firstError: d.firstNightError,
    })
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
        return []
      const ranges = [...pending.values()]
      pending.clear()
      const startedAt = now()
      const totals = { ranges: ranges.length, nights: 0, sessions: 0, stages: 0, failedNights: 0, failedRanges: 0 }
      for (const p of ranges) {
        let derived: DerivedRange | undefined
        try {
          derived = await deriveRange(p)
          const { sessions, stages } = derived
          logRange(p, derived)
          if (derived.stopped) {
            totals.failedRanges += 1
            logError(deps.logger, 'sync.sleep-derive: correction stopped part-way; stopped night may be missing rows', {
              userId: tailId(p.userId),
              deviceId: tailId(p.deviceId),
              stoppedAt: derived.stopped.night,
              nightsReplaced: derived.stopped.nightsReplaced,
              err: describeError(derived.stopped.error),
            })
          }
          totals.nights += derived.nights
          totals.sessions += sessions.length
          totals.stages += stages.length
          totals.failedNights += derived.failedNights.length
          const tenant = { brand: p.brand, familyId: p.familyId, userId: p.userId, deviceId: p.deviceId }
          if (sessions.length > 0)
            await deps.buffer.push({ table: 'sleep_session', ...tenant, rows: sessions as unknown as Record<string, unknown>[] })
          if (stages.length > 0)
            await deps.buffer.push({ table: 'sleep_stage', ...tenant, rows: stages as unknown as Record<string, unknown>[] })
        }
        catch (err) {
          // Unexpected: per-night failures are caught inside the pipeline,
          // and a failed replace is `derived.stopped`. Before `derived` the
          // range failed with no night replaced; after it, the stored nights
          // were replaced but their corrected rows never reached the buffer.
          totals.failedRanges += 1
          logError(deps.logger, derived
            ? 'sync.sleep-derive: corrected rows not buffered; replaced nights are missing'
            : 'sync.sleep-derive: correction failed; raw sleep kept, nights unchanged', {
            userId: tailId(p.userId),
            deviceId: tailId(p.deviceId),
            err: describeError(err),
          })
        }
      }
      // Once per batch cycle that had sleep to correct.
      deps.logger?.info('sync.sleep-derive: derived', { ...totals, reason, durationMs: now() - startedAt })
      // Land the derived rows inside this batch, so batch:complete follows them.
      return [
        await deps.flusher.flush('sleep_session', reason, batchId),
        await deps.flusher.flush('sleep_stage', reason, batchId),
      ]
    },
  }
}

/**
 * Fold the deriver's flush results into a batch's per-table results.
 *
 * The batch flushed `sleep_session` / `sleep_stage` once already (empty: the
 * derived rows did not exist yet), so the derived result is merged into that
 * entry rather than appended — one entry per table, as callers that key by
 * table (`Object.fromEntries`) expect. Counts add; a failure on either side
 * makes the table failed, keeping the first error.
 */
export function mergeFlushResults(results: readonly FlushResult[], derived: readonly FlushResult[]): FlushResult[] {
  const out = [...results]
  for (const d of derived) {
    const i = out.findIndex(r => r.table === d.table)
    if (i === -1) {
      out.push(d)
      continue
    }
    const r = out[i]
    const inserted = (r.rowsInserted ?? 0) + (d.rowsInserted ?? 0)
    const rejected = (r.rowsRejected ?? 0) + (d.rowsRejected ?? 0)
    out[i] = {
      ...r,
      ...d,
      table: r.table,
      rowsFlushed: r.rowsFlushed + d.rowsFlushed,
      ...(r.rowsInserted != null || d.rowsInserted != null ? { rowsInserted: inserted } : {}),
      ...(r.rowsRejected != null || d.rowsRejected != null ? { rowsRejected: rejected } : {}),
      ok: r.ok && d.ok,
      ...(r.error ?? d.error ? { error: r.error ?? d.error } : {}),
    }
  }
  return out
}
