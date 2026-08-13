/**
 * Sleep reconstruction mapper (T-06).
 *
 * Firmware `sleep_processed` emits per-block rows tagged with a `start`
 * (session start), `end` (session end), `block_type` (primary / light / deep /
 * rem / awake), `confidence` (0..1), and per-block `timestamp` (block instant).
 * Multiple blocks share the same `start` when they belong to the same session.
 *
 * Reconstruction rules (spec.md §Firmware mapper + tasks.md T-06):
 *   - Group rows by `start`.
 *   - A session is included if AT LEAST ONE block in the group has
 *     `block_type === 'primary'` AND `confidence >= 0.7`. This filters
 *     day-time naps and low-confidence noise.
 *   - Session boundaries come from the firmware's own envelope fields:
 *     `ts_start = parse(start)`, `ts_end = parse(end)`. `total_minutes` is
 *     their difference. Deriving the envelope from block instants would
 *     under-report any session whose first/last minutes went unclassified.
 *   - `session_id` = `nanoid(24) + '_' + fnv1a32hex(device_id | user_id |
 *     ts_session_start)` (principle 25, locked) — collision-safe even with
 *     corrupted timestamps.
 *   - `night_of` = 6pm-6pm rule applied to `ts_start` (see `time.ts`).
 *   - Stages: one row per classified block, carrying `session_id` and the
 *     DDL's integer `stage` code. `primary` is the session envelope marker,
 *     not a stage, so it produces no `sleep_stage` row — the DDL's stage
 *     enum (1=awake, 2=light, 3=deep, 5=rem) has no code for it. Unknown
 *     block types are likewise skipped; nothing is lost, because...
 *   - Raw: every input row is preserved in `sleep_raw` regardless of the
 *     primary/confidence filter, flattened onto the DDL's columns, so
 *     downstream reprocessing can revisit sessions with new heuristics.
 *
 * Principle 20 boundary: firmware `block_type` strings are translated to our
 * integer codes here and never reach the warehouse.
 */

import type {
  FirmwareSleepRow,
  MapperContext,
  SleepRawRow,
  SleepSessionRow,
  SleepStageRow,
} from './types'
import { nanoid } from 'nanoid'
import { computeNightOf, parseTimestamp } from './time'

const MINUTE_MS = 60_000
const PRIMARY = 'primary'
const CONFIDENCE_FLOOR = 0.7

/**
 * Block width in minutes when the firmware revision omits `unit_length`.
 * Firmware doc §Sleep processing: blocks are 1-min wide by convention.
 */
export const DEFAULT_BLOCK_MINUTES = 1

/**
 * Firmware `block_type` → `sleep_stage.stage` code (spec §Table schema:
 * `stage SMALLINT NOT NULL -- 1=awake, 2=light, 3=deep, 5=rem`).
 *
 * `primary` is deliberately absent: it marks the session envelope, not a
 * sleep stage. The enum is intentionally sparse (no 4) to match the DDL
 * comment verbatim.
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

export interface ReconstructSleepResult {
  sleep_session: SleepSessionRow[]
  sleep_stage: SleepStageRow[]
  sleep_raw: SleepRawRow[]
}

/** Per-block width, honouring a firmware-supplied `unit_length`. */
function blockMinutes(row: FirmwareSleepRow): number {
  return typeof row.unit_length === 'number' && row.unit_length > 0
    ? row.unit_length
    : DEFAULT_BLOCK_MINUTES
}

/**
 * `sleep_raw.quality` is NOT NULL. Firmware revisions that carry a native
 * `quality` pass it through verbatim; older revisions derive it from the
 * block confidence (0..1 → 0..100) so the column is always populated.
 */
function rawQuality(row: FirmwareSleepRow): number {
  return typeof row.quality === 'number'
    ? row.quality
    : Math.round(row.confidence * 100)
}

export function reconstructSleepSessions(
  rows: readonly FirmwareSleepRow[],
  ctx: MapperContext,
): ReconstructSleepResult {
  const sleep_session: SleepSessionRow[] = []
  const sleep_stage: SleepStageRow[] = []
  const sleep_raw: SleepRawRow[] = []

  // Raw pass — every input row preserved for reprocessing, including rows
  // from sessions the primary/confidence filter drops.
  for (const row of rows) {
    sleep_raw.push({
      ts: parseTimestamp(row.timestamp),
      ts_session_start: parseTimestamp(row.start),
      brand: ctx.brand,
      family_id: ctx.familyId,
      user_id: ctx.userId,
      device_id: ctx.deviceId,
      quality: rawQuality(row),
      unit_length: typeof row.unit_length === 'number' ? row.unit_length : null,
    })
  }

  // Group by `start`.
  const bySession = new Map<string, FirmwareSleepRow[]>()
  for (const row of rows) {
    const bucket = bySession.get(row.start)
    if (bucket)
      bucket.push(row)
    else bySession.set(row.start, [row])
  }

  for (const [startKey, blocks] of bySession) {
    // Session must contain a primary block above the confidence floor to be
    // counted as a real sleep session (as opposed to a nap or noise).
    const hasQualifyingPrimary = blocks.some(
      b => b.block_type === PRIMARY && b.confidence >= CONFIDENCE_FLOOR,
    )
    if (!hasQualifyingPrimary)
      continue

    // Envelope from the firmware's own session fields. `end` is exclusive of
    // nothing — it is the session end instant, so total is a plain delta.
    const tsStart = parseTimestamp(startKey)
    const tsEnd = parseTimestamp(blocks[0].end)
    const totalMinutes = Math.max(
      0,
      Math.round((tsEnd.getTime() - tsStart.getTime()) / MINUTE_MS),
    )

    const nightOf = computeNightOf(tsStart, ctx.userTimezone)
    const sessionId = makeSessionId(ctx, tsStart)

    // Stage rows + per-stage minute accumulation in one pass.
    const stageMinutes: Record<string, number> = {
      awake: 0,
      light: 0,
      deep: 0,
      rem: 0,
    }
    let confidenceSum = 0
    for (const b of blocks) {
      confidenceSum += b.confidence
      const code = SLEEP_STAGE_CODES[b.block_type]
      if (code === undefined) {
        // `primary` (envelope marker) and any unrecognised firmware block
        // type. Not a stage — preserved in sleep_raw, skipped here.
        continue
      }
      stageMinutes[SLEEP_STAGE_NAMES[code]] += blockMinutes(b)
      sleep_stage.push({
        ts: parseTimestamp(b.timestamp),
        brand: ctx.brand,
        family_id: ctx.familyId,
        user_id: ctx.userId,
        device_id: ctx.deviceId,
        session_id: sessionId,
        stage: code,
        confidence: b.confidence,
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
      total_minutes: totalMinutes,
      deep_minutes: stageMinutes.deep,
      rem_minutes: stageMinutes.rem,
      light_minutes: stageMinutes.light,
      awake_minutes: stageMinutes.awake,
      avg_confidence: blocks.length > 0 ? confidenceSum / blocks.length : null,
      night_of: nightOf,
    })
  }

  return { sleep_session, sleep_stage, sleep_raw }
}

/**
 * Session id components (principle 25, locked):
 *   `nanoid(24) + '_' + fnv1a32hex(device_id | user_id | ts_session_start)`
 *
 * The random prefix makes ids collision-safe even when the firmware emits
 * corrupted/duplicated timestamps; the hash suffix is deterministic over the
 * identifying tuple so ids remain diagnosable (same device+user+start ⇒
 * same suffix). The random source is injectable via `ctx.idGenerator` to
 * keep the mapper testable — the suffix is always deterministic.
 */
export function sessionIdComponents(
  ctx: MapperContext,
  tsSessionStart: Date,
): { random: string, hash: string } {
  const random = ctx.idGenerator ? ctx.idGenerator() : nanoid(24)
  const hash = fnv1a32hex(
    `${ctx.deviceId}|${ctx.userId}|${tsSessionStart.toISOString()}`,
  )
  return { random, hash }
}

function makeSessionId(ctx: MapperContext, startTs: Date): string {
  const { random, hash } = sessionIdComponents(ctx, startTs)
  return `${random}_${hash}`
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
