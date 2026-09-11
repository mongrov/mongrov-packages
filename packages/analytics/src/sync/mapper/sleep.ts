/**
 * Sleep mapping (sleep-correction §3).
 *
 * Two halves that run at different times:
 *
 *   - `mapSleepRaw`, at ingest: every raw firmware sample → `sleep_raw`,
 *     verbatim. `quality` stays the FIRMWARE code (1 deep / 2 light / 3 rem /
 *     5 awake, other codes kept). Nothing is classified here — `sleep_raw` is
 *     the reprocessing source the correction pipeline reads.
 *   - `sessionsFromCorrected`, after the batch flushes: one night's Phase 3
 *     output from `../sleep-correction` → `sleep_session` + `sleep_stage`.
 *
 * Until 0.24.0 the mapper built sessions straight from app-classified blocks
 * (`sleep_processed`) — an admission filter on `primary`, a per-block `end`
 * read as the session end, and a guessed stage map. All three were wrong on
 * device (zivaone_app#77, and the stage swap found 2026-09-10). Sessions now
 * come only from the validated correction pipeline.
 *
 * Principle 20: the firmware `quality` code is translated to the DDL's
 * `stage` code here, and nowhere else. The two enums share integers and mean
 * different things — `FIRMWARE_QUALITY_TO_STAGE` is the one crossing point.
 */

import type { ClassifiedRow } from '../sleep-correction/classify'
import type {
  FirmwareSleepRawRow,
  MapperContext,
  SleepRawRow,
  SleepSessionRow,
  SleepStageRow,
} from './types'
import { parseDateStr } from '../sleep-correction/classify'
import { computeNightOf, parseTimestamp } from './time'

/**
 * `sleep_stage.stage` codes (DDL: `1=awake, 2=light, 3=deep, 5=rem`). Sparse
 * on purpose (no 4) to match the DDL comment verbatim.
 */
export const SLEEP_STAGE_CODES: Readonly<Record<string, number>> = Object.freeze({
  awake: 1,
  light: 2,
  deep: 3,
  rem: 5,
})

/** Reverse lookup for the stage-minute accumulator + diagnostics. */
export const SLEEP_STAGE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: 'awake',
  2: 'light',
  3: 'deep',
  5: 'rem',
})

/**
 * Firmware `quality` → DDL `stage`. The firmware says 1 deep / 2 light /
 * 3 rem / 5 awake (ziva_app v3.1; the vendor header is silent); the DDL says
 * 1 awake / 2 light / 3 deep / 5 rem. Copying a predicate across the two
 * computes deep from awake with no error — this map is the only translation.
 */
export const FIRMWARE_QUALITY_TO_STAGE: Readonly<Record<number, number>> = Object.freeze({
  1: SLEEP_STAGE_CODES.deep,
  2: SLEEP_STAGE_CODES.light,
  3: SLEEP_STAGE_CODES.rem,
  5: SLEEP_STAGE_CODES.awake,
})

/** Raw firmware samples → `sleep_raw`, verbatim. */
export function mapSleepRaw(rows: readonly FirmwareSleepRawRow[], ctx: MapperContext): SleepRawRow[] {
  return rows.map(r => ({
    ts: parseTimestamp(r.timestamp),
    ts_session_start: parseTimestamp(r.start),
    brand: ctx.brand,
    family_id: ctx.familyId,
    user_id: ctx.userId,
    device_id: ctx.deviceId,
    quality: r.quality,
    unit_length: typeof r.unitLength === 'number' ? r.unitLength : null,
  }))
}

export interface SessionsFromCorrectedResult {
  sleep_session: SleepSessionRow[]
  sleep_stage: SleepStageRow[]
}

/** Width of one Phase 2/3 row. v3.1 emits every row at `unitLength` 1. */
const ROW_SECONDS = 60

/**
 * One night's corrected rows → sessions + stages.
 *
 * - Only `block_type === 'primary'` rows count (R-A: every primary minute,
 *   whatever its confidence — confidence is provenance, never a gate).
 * - Sessions are Phase 2's stitched sessions, identified by `start`. A night
 *   is normally one; a gap between 20 and 30 minutes inside the primary
 *   block leaves two.
 * - `ts_end` is the last primary minute plus its width; `total_minutes` is
 *   the primary minutes actually present (awake minutes included).
 * - `settle_min` belongs to the night, measured from bed, so it goes on the
 *   session that starts at bed — the first. `recovered_min` is per session.
 * - `session_id` is principle 25's deterministic hash; the caller replaces
 *   the whole night before writing (principle 66 as amended), because a
 *   corrected END moves as later data arrives and the id moves with it.
 */
export function sessionsFromCorrected(
  rows: readonly ClassifiedRow[],
  ctx: MapperContext,
  night: { settleMin?: number | null } = {},
): SessionsFromCorrectedResult {
  const bySession = new Map<string, ClassifiedRow[]>()
  for (const r of rows) {
    if (r.block_type !== 'primary')
      continue
    const bucket = bySession.get(r.start)
    if (bucket)
      bucket.push(r)
    else bySession.set(r.start, [r])
  }

  const groups = Array.from(bySession.values(), g => g.map(r => ({ r, e: parseDateStr(r.date) })).sort((a, b) => a.e - b.e))
    .sort((a, b) => a[0].e - b[0].e)

  const sleep_session: SleepSessionRow[] = []
  const sleep_stage: SleepStageRow[] = []
  groups.forEach((group, index) => {
    const tsStart = new Date(group[0].e * 1000)
    const tsEnd = new Date((group[group.length - 1].e + ROW_SECONDS) * 1000)
    const sessionId = makeSessionId(ctx, tsStart, tsEnd)

    const minutes: Record<string, number> = { awake: 0, light: 0, deep: 0, rem: 0 }
    let confidenceSum = 0
    let recovered = 0
    for (const { r, e } of group) {
      confidenceSum += r.confidence
      if (r.source === 'envelope' || r.source === 'gap')
        recovered++
      const stage = FIRMWARE_QUALITY_TO_STAGE[r.quality]
      if (stage === undefined)
        continue // a code the pipeline passed but the DDL has no stage for
      minutes[SLEEP_STAGE_NAMES[stage]]++
      sleep_stage.push({
        ts: new Date(e * 1000),
        brand: ctx.brand,
        family_id: ctx.familyId,
        user_id: ctx.userId,
        device_id: ctx.deviceId,
        session_id: sessionId,
        stage,
        confidence: r.confidence,
        source: r.source,
      })
    }

    sleep_session.push({
      brand: ctx.brand,
      family_id: ctx.familyId,
      user_id: ctx.userId,
      device_id: ctx.deviceId,
      session_id: sessionId,
      ts_start: tsStart,
      ts_end: tsEnd,
      total_minutes: group.length,
      deep_minutes: minutes.deep,
      rem_minutes: minutes.rem,
      light_minutes: minutes.light,
      awake_minutes: minutes.awake,
      avg_confidence: confidenceSum / group.length,
      night_of: computeNightOf(tsStart, ctx.userTimezone),
      settle_min: index === 0 ? (night.settleMin ?? null) : null,
      recovered_min: recovered,
    })
  })

  return { sleep_session, sleep_stage }
}

/**
 * Session id (principle 25, as amended 2026-08-14):
 *   `fnv1a32hex(device_id | user_id | ts_session_start | ts_session_end)`
 *
 * Fully deterministic — the same night mapped twice yields the same id.
 * It previously carried a `nanoid(24)` prefix, which made every re-sync
 * produce a new id for a night already stored, indistinguishable from a
 * second night. Measured on device at ~8x row inflation, which then skews the
 * `sleep_total_minutes` percentiles in `user_baseline` (zivaone_app#75).
 *
 * `ts_session_end` is in the tuple, not decoration: it is what recovers the
 * collision-safety the random prefix was there for. Two genuinely distinct
 * sessions that share a start remain distinguishable. If firmware ever
 * duplicates start AND end, the two are identical under every identifying
 * field we hold and no id scheme can separate them.
 *
 * Deduplication is the job of the table's identity key (principle 66), never
 * of the id.
 */
export function makeSessionId(
  ctx: MapperContext,
  tsSessionStart: Date,
  tsSessionEnd: Date,
): string {
  return fnv1a32hex(
    `${ctx.deviceId}|${ctx.userId}|${tsSessionStart.toISOString()}`
    + `|${tsSessionEnd.toISOString()}`,
  )
}

/**
 * FNV-1a 32-bit, hex-encoded (8 lowercase hex chars). Implemented inline —
 * a dependency for 10 lines of arithmetic is not worth the supply-chain
 * surface, and the mapper only needs a stable non-cryptographic digest.
 */
export function fnv1a32hex(input: string): string {
  let h = 0x811C9DC5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
