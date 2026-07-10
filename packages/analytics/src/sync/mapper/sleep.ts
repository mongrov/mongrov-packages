/**
 * Sleep reconstruction mapper (T-06).
 *
 * Firmware `sleep_processed` emits per-block rows tagged with a `start`
 * (session start), `end`, `block_type` (primary / light / deep / rem / ...),
 * `confidence` (0..1), and per-block `timestamp` (block instant). Multiple
 * blocks share the same `start` when they belong to the same sleep session.
 *
 * Reconstruction rules (spec.md §Firmware mapper + tasks.md T-06):
 *   - Group rows by `start`.
 *   - A session is included if AT LEAST ONE block in the group has
 *     `block_type === 'primary'` AND `confidence >= 0.7`. This filters
 *     day-time naps and low-confidence noise.
 *   - Session boundaries: `start_ts` = earliest block ts in the group;
 *     `end_ts` = latest block ts + 1 minute (block ts marks start of the
 *     1-min block).
 *   - `session_id` = stable hash of `user_id + start_ts.toISOString()`.
 *   - `night_of` = 6pm-6pm rule applied to `start_ts` (see `time.ts`).
 *   - Stages: one row per firmware block that passed the primary+confidence
 *     filter, carrying `session_id`, `block_type`, and `confidence`.
 *   - Raw: every input row is preserved verbatim in `sleep_raw` (payload
 *     column) regardless of the primary/confidence filter, so downstream
 *     reprocessing can revisit sessions with new heuristics.
 */

import { computeNightOf, parseTimestamp } from './time'
import type {
  FirmwareSleepRow,
  MapperContext,
  SleepRawRow,
  SleepSessionRow,
  SleepStageRow,
} from './types'

const MINUTE_MS = 60_000
const PRIMARY = 'primary'
const CONFIDENCE_FLOOR = 0.7

export interface ReconstructSleepResult {
  sleep_session: SleepSessionRow[]
  sleep_stage: SleepStageRow[]
  sleep_raw: SleepRawRow[]
}

export function reconstructSleepSessions(
  rows: readonly FirmwareSleepRow[],
  ctx: MapperContext,
): ReconstructSleepResult {
  const sleep_session: SleepSessionRow[] = []
  const sleep_stage: SleepStageRow[] = []
  const sleep_raw: SleepRawRow[] = []

  // Raw pass — all input rows preserved verbatim for reprocessing.
  for (const row of rows) {
    sleep_raw.push({
      ts: parseTimestamp(row.timestamp),
      brand: ctx.brand,
      family_id: ctx.familyId,
      user_id: ctx.userId,
      device_id: ctx.deviceId,
      payload: row,
    })
  }

  // Group by `start`.
  const bySession = new Map<string, FirmwareSleepRow[]>()
  for (const row of rows) {
    const bucket = bySession.get(row.start)
    if (bucket) bucket.push(row)
    else bySession.set(row.start, [row])
  }

  for (const [startKey, blocks] of bySession) {
    // Session must contain a primary block above the confidence floor to be
    // counted as a real sleep session (as opposed to a nap or noise).
    const hasQualifyingPrimary = blocks.some(
      b => b.block_type === PRIMARY && b.confidence >= CONFIDENCE_FLOOR,
    )
    if (!hasQualifyingPrimary) continue

    const blockInstants = blocks.map(b => parseTimestamp(b.timestamp))
    const startTs = new Date(Math.min(...blockInstants.map(d => d.getTime())))
    // Sessions extend to the end of the last block (blocks are 1-min wide by
    // convention — firmware doc §Sleep processing).
    const endTs = new Date(
      Math.max(...blockInstants.map(d => d.getTime())) + MINUTE_MS,
    )
    const nightOf = computeNightOf(startTs, ctx.userTimezone)
    const sessionId = makeSessionId(ctx.userId, startTs)

    sleep_session.push({
      ts: startTs,
      brand: ctx.brand,
      family_id: ctx.familyId,
      user_id: ctx.userId,
      device_id: ctx.deviceId,
      session_id: sessionId,
      start_ts: startTs,
      end_ts: endTs,
      night_of: nightOf,
    })

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      sleep_stage.push({
        ts: blockInstants[i],
        brand: ctx.brand,
        family_id: ctx.familyId,
        user_id: ctx.userId,
        device_id: ctx.deviceId,
        session_id: sessionId,
        stage: b.block_type,
        confidence: b.confidence,
      })
    }
    // Reference `startKey` to silence "unused" if TS ever tightens loop typing.
    void startKey
  }

  return { sleep_session, sleep_stage, sleep_raw }
}

/**
 * Stable, non-cryptographic session id: `<userId>:<startIso>`. Deterministic
 * so re-imports don't produce duplicates; carries enough context to survive
 * cross-user joins without collision at the user's cardinality.
 */
function makeSessionId(userId: string, startTs: Date): string {
  return `${userId}:${startTs.toISOString()}`
}
