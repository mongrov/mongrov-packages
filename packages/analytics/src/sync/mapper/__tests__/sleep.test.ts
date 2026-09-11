/**
 * Sleep mapping (sleep-correction §3).
 *
 * Coverage:
 *   1. `mapSleepRaw`: raw firmware samples land in `sleep_raw` verbatim —
 *      the firmware quality code untranslated, sub-stage codes (11) kept.
 *   2. `sessionsFromCorrected`: only primary rows count; sessions are Phase
 *      2's `start` groups; the end is the last primary minute + 1; the
 *      firmware code is translated to the DDL stage code (the enum swap the
 *      app shipped for months); provenance lands on each stage row;
 *      settle_min on the first session only; ids per principle 25.
 */

import type { ClassifiedRow } from '../../sleep-correction/classify'
import type { FirmwareSleepRawRow, MapperContext } from '../types'

import { describe, expect, it } from 'vitest'
import {
  FIRMWARE_QUALITY_TO_STAGE,
  fnv1a32hex,
  mapSleepRaw,
  sessionsFromCorrected,
  SLEEP_STAGE_CODES,
} from '../sleep'

const ctx: MapperContext = {
  brand: 'ziva',
  familyId: 'fam_test',
  userId: 'user_alice',
  deviceId: 'ring_8047',
  userTimezone: 'America/Los_Angeles',
}

const SESSION_ID_RE = /^[0-9a-f]{8}$/
const DASH_RE = /-/g
const at = (iso: string) => Date.parse(`${iso}Z`) / 1000
const fmt = (e: number) => new Date(e * 1000).toISOString().slice(0, 19).replace('T', ' ').replace(DASH_RE, '.')

/** `minutes` corrected rows from `from` (UTC), all one Phase 2 session. */
function corrected(
  from: string,
  minutes: number,
  opts: { quality?: number, source?: string, block_type?: string, start?: string } = {},
): ClassifiedRow[] {
  const s = at(from)
  return Array.from({ length: minutes }, (_, i) => ({
    date: fmt(s + i * 60),
    quality: opts.quality ?? 2,
    start: opts.start ?? fmt(s),
    unitLength: 1,
    source: opts.source ?? 'firmware',
    confidence: opts.source && opts.source !== 'firmware' ? 0.5 : 0.9,
    block_type: opts.block_type ?? 'primary',
  }))
}

describe('mapSleepRaw', () => {
  it('lands raw samples verbatim — firmware codes, sub-stage codes kept', () => {
    const fw: FirmwareSleepRawRow[] = [
      { timestamp: '2026.06.18 05:00:00', quality: 1, start: '2026.06.18 05:00:00', unitLength: 1 },
      { timestamp: '2026.06.18 05:01:00', quality: 11, start: '2026.06.18 05:00:00', unitLength: 1 },
    ]
    const raw = mapSleepRaw(fw, ctx)
    expect(raw).toHaveLength(2)
    expect(raw[0]).toMatchObject({
      quality: 1, // firmware "deep" — NOT translated at ingest
      unit_length: 1,
      brand: 'ziva',
      family_id: 'fam_test',
      user_id: 'user_alice',
      device_id: 'ring_8047',
    })
    expect(raw[0].ts.toISOString()).toBe('2026-06-18T05:00:00.000Z')
    expect(raw[0].ts_session_start.toISOString()).toBe('2026-06-18T05:00:00.000Z')
    expect(raw[1].quality).toBe(11)
  })
})

describe('sessionsFromCorrected', () => {
  it('translates firmware quality to the DDL stage code — the two enums differ', () => {
    // Firmware 1/2/3/5 = deep/light/rem/awake; DDL 1/2/3/5 = awake/light/deep/rem.
    expect(FIRMWARE_QUALITY_TO_STAGE).toEqual({
      1: SLEEP_STAGE_CODES.deep,
      2: SLEEP_STAGE_CODES.light,
      3: SLEEP_STAGE_CODES.rem,
      5: SLEEP_STAGE_CODES.awake,
    })
    const night = [
      ...corrected('2026-06-18T05:00:00', 1, { quality: 1, start: '2026.06.18 05:00:00' }),
      ...corrected('2026-06-18T05:01:00', 1, { quality: 2, start: '2026.06.18 05:00:00' }),
      ...corrected('2026-06-18T05:02:00', 1, { quality: 3, start: '2026.06.18 05:00:00' }),
      ...corrected('2026-06-18T05:03:00', 1, { quality: 5, start: '2026.06.18 05:00:00' }),
    ]
    const { sleep_stage, sleep_session } = sessionsFromCorrected(night, ctx)
    expect(sleep_stage.map(s => s.stage)).toEqual([3, 2, 5, 1])
    expect(sleep_session[0]).toMatchObject({ deep_minutes: 1, light_minutes: 1, rem_minutes: 1, awake_minutes: 1 })
  })

  it('counts primary rows only, and ends a session one minute after its last primary minute', () => {
    const rows = [
      ...corrected('2026-06-18T04:00:00', 30, { block_type: 'secondary', source: 'envelope', start: '2026.06.18 04:00:00' }),
      ...corrected('2026-06-18T05:00:00', 420, { start: '2026.06.18 04:00:00' }),
      ...corrected('2026-06-18T14:00:00', 20, { block_type: 'microsleep', source: 'envelope' }),
    ]
    const { sleep_session, sleep_stage } = sessionsFromCorrected(rows, ctx)
    expect(sleep_session).toHaveLength(1)
    const [s] = sleep_session
    expect(s.ts_start.toISOString()).toBe('2026-06-18T05:00:00.000Z')
    expect(s.ts_end.toISOString()).toBe('2026-06-18T12:00:00.000Z')
    expect(s.total_minutes).toBe(420)
    expect(sleep_stage).toHaveLength(420)
    expect(s.session_id).toMatch(SESSION_ID_RE)
    expect(sleep_stage.every(st => st.session_id === s.session_id)).toBe(true)
    // night_of: 05:00 UTC = 22:00 PDT on the 17th → night of the 17th (6pm–6pm).
    expect(s.night_of.toISOString()).toBe('2026-06-17T00:00:00.000Z')
  })

  it('keeps provenance on every stage and counts recovered minutes per session', () => {
    const rows = [
      ...corrected('2026-06-18T05:00:00', 10),
      ...corrected('2026-06-18T05:10:00', 5, { source: 'envelope', start: '2026.06.18 05:00:00' }),
      ...corrected('2026-06-18T05:15:00', 3, { source: 'gap', start: '2026.06.18 05:00:00' }),
    ]
    const { sleep_session, sleep_stage } = sessionsFromCorrected(rows, ctx)
    expect(sleep_session[0].recovered_min).toBe(8)
    expect(new Set(sleep_stage.map(s => s.source))).toEqual(new Set(['firmware', 'envelope', 'gap']))
  })

  it('splits Phase 2 sessions by `start`; settle_min goes on the session that starts at bed', () => {
    const rows = [
      ...corrected('2026-06-18T05:00:00', 60),
      ...corrected('2026-06-18T06:25:00', 60), // a later stitched session in the same block
    ]
    const { sleep_session } = sessionsFromCorrected(rows, ctx, { settleMin: 12 })
    expect(sleep_session).toHaveLength(2)
    expect(sleep_session.map(s => s.settle_min)).toEqual([12, null])
  })

  it('builds principle-25 ids: deterministic, and different when the end moves', () => {
    const night = corrected('2026-06-18T05:00:00', 420)
    const [a] = sessionsFromCorrected(night, ctx).sleep_session
    expect(a.session_id).toBe(fnv1a32hex(
      `ring_8047|user_alice|${new Date('2026-06-18T05:00:00Z').toISOString()}|${new Date('2026-06-18T12:00:00Z').toISOString()}`,
    ))
    expect(sessionsFromCorrected(night, ctx).sleep_session[0].session_id).toBe(a.session_id)
    // A later correction that extends the night is a different id — which is
    // why the caller replaces the night rather than appending.
    const longer = sessionsFromCorrected(corrected('2026-06-18T05:00:00', 450), ctx).sleep_session[0]
    expect(longer.session_id).not.toBe(a.session_id)
  })

  it('emits nothing for a night with no primary block', () => {
    const rows = corrected('2026-06-18T05:00:00', 30, { block_type: 'secondary' })
    expect(sessionsFromCorrected(rows, ctx)).toEqual({ sleep_session: [], sleep_stage: [] })
  })
})
