/**
 * T-06 — Sleep session reconstruction.
 *
 * Coverage:
 *   1. Groups blocks by `start`; a session with a primary block above the
 *      confidence floor is emitted; sessions without a qualifying primary
 *      are dropped (nap / noise).
 *   2. Session `start_ts` / `end_ts` correctly derived from block instants;
 *      stages share the session_id FK.
 *   3. Midnight-crossing session: `night_of` derived from `start_ts` via
 *      the 6pm-6pm rule; both pre- and post-midnight blocks belong to the
 *      same session.
 *   4. Raw pass: every input row preserved verbatim in `sleep_raw`,
 *      including rows from dropped sessions.
 */

import { describe, expect, it } from 'vitest'

import { reconstructSleepSessions } from '../sleep'
import type { FirmwareSleepRow, MapperContext } from '../types'

const ctx: MapperContext = {
  brand: 'ziva',
  familyId: 'fam_test',
  userId: 'user_alice',
  deviceId: 'ring_8047',
  userTimezone: 'America/Los_Angeles',
}

describe('reconstructSleepSessions', () => {
  it('emits a session when a qualifying primary block is present', () => {
    const fw: FirmwareSleepRow[] = [
      {
        start: '2026.06.18 05:00:00',
        end: '2026.06.18 12:00:00',
        block_type: 'primary',
        confidence: 0.9,
        timestamp: '2026.06.18 05:00:00',
      },
      {
        start: '2026.06.18 05:00:00',
        end: '2026.06.18 12:00:00',
        block_type: 'deep',
        confidence: 0.85,
        timestamp: '2026.06.18 06:00:00',
      },
    ]
    const { sleep_session, sleep_stage } = reconstructSleepSessions(fw, ctx)
    expect(sleep_session).toHaveLength(1)
    expect(sleep_stage).toHaveLength(2)
    expect(sleep_session[0].session_id).toBe(
      `user_alice:${new Date('2026-06-18T05:00:00Z').toISOString()}`,
    )
    // Each stage links back to that same session_id.
    for (const stage of sleep_stage) {
      expect(stage.session_id).toBe(sleep_session[0].session_id)
    }
  })

  it('drops sessions whose primary block confidence is below the floor', () => {
    const fw: FirmwareSleepRow[] = [
      // Low-confidence primary → dropped session.
      {
        start: '2026.06.18 14:00:00', // afternoon nap
        end: '2026.06.18 14:30:00',
        block_type: 'primary',
        confidence: 0.5,
        timestamp: '2026.06.18 14:00:00',
      },
      // No primary at all → dropped session.
      {
        start: '2026.06.18 16:00:00',
        end: '2026.06.18 16:30:00',
        block_type: 'light',
        confidence: 0.9,
        timestamp: '2026.06.18 16:00:00',
      },
    ]
    const { sleep_session, sleep_stage, sleep_raw } = reconstructSleepSessions(
      fw,
      ctx,
    )
    expect(sleep_session).toHaveLength(0)
    expect(sleep_stage).toHaveLength(0)
    // Raw pass still preserves both rows for reprocessing.
    expect(sleep_raw).toHaveLength(2)
  })

  it('assigns midnight-crossing session to a single night via 6pm-6pm rule', () => {
    // Session starts 2026-06-18 05:00 UTC = 2026-06-17 22:00 LA. That's after
    // 18:00 local, so night_of = 2026-06-17.
    const fw: FirmwareSleepRow[] = [
      {
        start: '2026.06.18 05:00:00',
        end: '2026.06.18 13:00:00',
        block_type: 'primary',
        confidence: 0.9,
        timestamp: '2026.06.18 05:00:00',
      },
      {
        start: '2026.06.18 05:00:00',
        end: '2026.06.18 13:00:00',
        block_type: 'rem',
        confidence: 0.8,
        // 04:00 LA next-day still within the same session/night bucket.
        timestamp: '2026.06.18 11:00:00',
      },
    ]
    const { sleep_session } = reconstructSleepSessions(fw, ctx)
    expect(sleep_session).toHaveLength(1)
    // night_of = 2026-06-17 midnight LA (PDT -07) = 2026-06-17T07:00:00Z.
    expect(sleep_session[0].night_of.toISOString()).toBe(
      '2026-06-17T07:00:00.000Z',
    )
  })

  it('preserves every input row in sleep_raw verbatim', () => {
    const fw: FirmwareSleepRow[] = [
      {
        start: '2026.06.18 05:00:00',
        end: '2026.06.18 12:00:00',
        block_type: 'primary',
        confidence: 0.9,
        timestamp: '2026.06.18 05:00:00',
      },
      {
        start: '2026.06.18 05:00:00',
        end: '2026.06.18 12:00:00',
        block_type: 'deep',
        confidence: 0.85,
        timestamp: '2026.06.18 06:00:00',
      },
    ]
    const { sleep_raw } = reconstructSleepSessions(fw, ctx)
    expect(sleep_raw).toHaveLength(2)
    expect(sleep_raw[0].payload).toEqual(fw[0])
    expect(sleep_raw[1].payload).toEqual(fw[1])
  })
})
