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

import type { FirmwareSleepRow, MapperContext } from '../types'

import { describe, expect, it } from 'vitest'
import {
  fnv1a32hex,
  reconstructSleepSessions,
  SLEEP_STAGE_CODES,
} from '../sleep'

const ctx: MapperContext = {
  brand: 'ziva',
  familyId: 'fam_test',
  userId: 'user_alice',
  deviceId: 'ring_8047',
  userTimezone: 'America/Los_Angeles',
}

// Principle 25 shape: nanoid(24) + '_' + 8-hex-char fnv1a32 suffix.
// fnv1a32hex — 8 lowercase hex chars, no random prefix (principle 25,
// amended 2026-08-14).
const SESSION_ID_RE = /^[0-9a-f]{8}$/

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
    // `primary` is the session envelope marker, not a stage — only the
    // `deep` block yields a sleep_stage row (DDL stage enum has no
    // code for 'primary').
    expect(sleep_stage).toHaveLength(1)
    expect(sleep_stage[0].stage).toBe(SLEEP_STAGE_CODES.deep)
    expect(sleep_session[0].session_id).toMatch(SESSION_ID_RE)
    // Each stage links back to that same session_id.
    for (const stage of sleep_stage) {
      expect(stage.session_id).toBe(sleep_session[0].session_id)
    }
  })

  it('emits a DDL-shaped session row (T-06 / core spec §Table schema)', () => {
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
        confidence: 0.8,
        timestamp: '2026.06.18 06:00:00',
      },
      {
        start: '2026.06.18 05:00:00',
        end: '2026.06.18 12:00:00',
        block_type: 'rem',
        confidence: 0.7,
        timestamp: '2026.06.18 07:00:00',
      },
    ]
    const [session] = reconstructSleepSessions(fw, ctx).sleep_session

    // Envelope comes from the firmware's own start/end, not block instants.
    expect(session.ts_start.toISOString()).toBe('2026-06-18T05:00:00.000Z')
    expect(session.ts_end.toISOString()).toBe('2026-06-18T12:00:00.000Z')
    expect(session.total_minutes).toBe(420)

    // Stage minutes accumulate at the default 1-min block width.
    expect(session.deep_minutes).toBe(1)
    expect(session.rem_minutes).toBe(1)
    expect(session.light_minutes).toBe(0)
    expect(session.awake_minutes).toBe(0)

    // avg_confidence spans every block in the group, envelope included.
    expect(session.avg_confidence).toBeCloseTo((0.9 + 0.8 + 0.7) / 3, 10)

    // No stray `ts` — the DDL partitions sleep_session on day(ts_start).
    expect(session).not.toHaveProperty('ts')
    // Tenant columns present on every row (spec §Table schema).
    expect(session.brand).toBe('ziva')
    expect(session.family_id).toBe('fam_test')
    expect(session.user_id).toBe('user_alice')
    expect(session.device_id).toBe('ring_8047')
  })

  it('translates firmware block_type to the DDL stage enum (principle 20)', () => {
    const at = (type: string, minute: number): FirmwareSleepRow => ({
      start: '2026.06.18 05:00:00',
      end: '2026.06.18 06:00:00',
      block_type: type,
      confidence: 0.9,
      timestamp: `2026.06.18 05:0${minute}:00`,
    })
    const fw: FirmwareSleepRow[] = [
      at('primary', 0),
      at('awake', 1),
      at('light', 2),
      at('deep', 3),
      at('rem', 4),
      at('some_future_firmware_type', 5),
    ]
    const { sleep_stage, sleep_raw } = reconstructSleepSessions(fw, ctx)

    // primary + the unknown type are skipped; the four real stages map to
    // 1 / 2 / 3 / 5 per the DDL comment.
    expect(sleep_stage.map(s => s.stage)).toEqual([1, 2, 3, 5])
    // Every stage code is an integer — no firmware strings reach the schema.
    for (const stage of sleep_stage) {
      expect(Number.isInteger(stage.stage)).toBe(true)
    }
    // Nothing is lost: skipped blocks still land in sleep_raw.
    expect(sleep_raw).toHaveLength(6)
  })

  it('honours a firmware-supplied unit_length for stage minutes', () => {
    const fw: FirmwareSleepRow[] = [
      {
        start: '2026.06.18 05:00:00',
        end: '2026.06.18 06:00:00',
        block_type: 'primary',
        confidence: 0.9,
        timestamp: '2026.06.18 05:00:00',
      },
      {
        start: '2026.06.18 05:00:00',
        end: '2026.06.18 06:00:00',
        block_type: 'deep',
        confidence: 0.9,
        timestamp: '2026.06.18 05:10:00',
        unit_length: 15,
      },
    ]
    const [session] = reconstructSleepSessions(fw, ctx).sleep_session
    expect(session.deep_minutes).toBe(15)
  })

  it('builds deterministic session ids per principle 25 (amended 2026-08-14)', () => {
    const fw: FirmwareSleepRow[] = [
      {
        start: '2026.06.18 05:00:00',
        end: '2026.06.18 12:00:00',
        block_type: 'primary',
        confidence: 0.9,
        timestamp: '2026.06.18 05:00:00',
      },
    ]
    const expected = fnv1a32hex(
      `ring_8047|user_alice|${new Date('2026-06-18T05:00:00Z').toISOString()}`
      + `|${new Date('2026-06-18T12:00:00Z').toISOString()}`,
    )
    const { sleep_session } = reconstructSleepSessions(fw, ctx)
    expect(sleep_session[0].session_id).toBe(expected)

    // Changes when any identifying component changes.
    const otherDevice = reconstructSleepSessions(fw, { ...ctx, deviceId: 'ring_9999' })
    expect(otherDevice.sleep_session[0].session_id).not.toBe(expected)
  })

  it('maps the same night twice to the same id — re-sync is not a second night', () => {
    // This assertion is the inverse of the one it replaces. The old id
    // carried a `nanoid(24)` prefix and the test asserted two runs must NOT
    // collide; that is exactly what made every re-sync duplicate, measured on
    // device at ~8x row inflation (zivaone_app#75, principle 25 amended).
    const fw: FirmwareSleepRow[] = [
      {
        start: '2026.06.18 05:00:00',
        end: '2026.06.18 12:00:00',
        block_type: 'primary',
        confidence: 0.9,
        timestamp: '2026.06.18 05:00:00',
      },
    ]
    const a = reconstructSleepSessions(fw, ctx).sleep_session[0].session_id
    const b = reconstructSleepSessions(fw, ctx).sleep_session[0].session_id
    expect(a).toBe(b)
  })

  it('keeps sessions distinct when they share a start but differ in end', () => {
    // What `ts_session_end` in the tuple buys: the collision-safety the
    // random prefix used to provide, without sacrificing determinism.
    const base = {
      start: '2026.06.18 05:00:00',
      block_type: 'primary' as const,
      confidence: 0.9,
      timestamp: '2026.06.18 05:00:00',
    }
    const short = reconstructSleepSessions(
      [{ ...base, end: '2026.06.18 09:00:00' }] as FirmwareSleepRow[],
      ctx,
    ).sleep_session[0].session_id
    const long = reconstructSleepSessions(
      [{ ...base, end: '2026.06.18 12:00:00' }] as FirmwareSleepRow[],
      ctx,
    ).sleep_session[0].session_id

    expect(short).not.toBe(long)
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

  it('preserves every input row in sleep_raw, flattened onto DDL columns', () => {
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
        // Firmware revision that carries native quality + block width.
        quality: 73,
        unit_length: 5,
      },
    ]
    const { sleep_raw } = reconstructSleepSessions(fw, ctx)
    expect(sleep_raw).toHaveLength(2)

    // Row 0: no native quality → derived from confidence (0.9 → 90).
    expect(sleep_raw[0].ts.toISOString()).toBe('2026-06-18T05:00:00.000Z')
    expect(sleep_raw[0].ts_session_start.toISOString()).toBe(
      '2026-06-18T05:00:00.000Z',
    )
    expect(sleep_raw[0].quality).toBe(90)
    expect(sleep_raw[0].unit_length).toBeNull()

    // Row 1: firmware-supplied values pass through verbatim.
    expect(sleep_raw[1].ts.toISOString()).toBe('2026-06-18T06:00:00.000Z')
    expect(sleep_raw[1].quality).toBe(73)
    expect(sleep_raw[1].unit_length).toBe(5)

    // quality is NOT NULL in the DDL — never undefined on any row.
    for (const raw of sleep_raw) {
      expect(typeof raw.quality).toBe('number')
    }
  })
})
