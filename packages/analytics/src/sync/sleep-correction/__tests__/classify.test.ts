/**
 * Phase 3 (`classifyBlocks`) and the night window, on hand-built nights.
 *
 * The parity suite proves the port against v3.1 on real captures, but it needs
 * data this repo does not carry. These cases pin the behaviours that matter
 * most without it, so a refactor that breaks one fails on every CI run.
 */
import type { Phase2Row } from '../classify'

import { describe, expect, it } from 'vitest'

import { classifyBlocks, computeNightEpochs, CONF_BOUT, parseDateStr } from '../classify'

const DASH_RE = /-/g

/** Epoch seconds → the Phase 2 "YYYY.MM.DD HH:MM:SS" (UTC) string. */
function fmt(e: number): string {
  return new Date(e * 1000).toISOString().slice(0, 19).replace('T', ' ').replace(DASH_RE, '.')
}

const at = (iso: string) => Date.parse(`${iso}Z`) / 1000

/** `minutes` one-minute rows from `start`. */
function run(start: number, minutes: number, quality: number, source = 'firmware', session = 0): Phase2Row[] {
  return Array.from({ length: minutes }, (_, i) => ({
    date: fmt(start + i * 60),
    quality,
    start: fmt(start),
    unitLength: 1,
    source,
    confidence: source === 'firmware' ? 0.9 : 0.5,
    session_id: session,
  }))
}

describe('computeNightEpochs', () => {
  it('spans 18:00 local of the previous day to 18:00 local', () => {
    const { windowStart, windowEnd } = computeNightEpochs('2026-06-18', 5.5)
    expect(windowStart).toBe(at('2026-06-17T18:00:00') - 5.5 * 3600)
    expect(windowEnd - windowStart).toBe(86400)
  })
})

describe('parseDateStr', () => {
  it('reads the Phase 2 string as UTC', () => {
    expect(parseDateStr('2026.06.18 05:00:00')).toBe(at('2026-06-18T05:00:00'))
    expect(parseDateStr('')).toBe(0)
  })
})

describe('classifyBlocks', () => {
  it('returns nothing for no rows', () => {
    expect(classifyBlocks([], 0)).toEqual([])
  })

  it('marks a firmware night primary, end to end', () => {
    const out = classifyBlocks(run(at('2026-06-17T23:00:00'), 420, 2), 0)
    expect(new Set(out.map(r => r.block_type))).toEqual(new Set(['primary']))
  })

  it('marks a short envelope-only daytime block microsleep, not a second night', () => {
    const night = run(at('2026-06-17T23:00:00'), 420, 2)
    const nap = run(at('2026-06-18T14:00:00'), 20, 2, 'envelope', 1)
    const out = classifyBlocks([...night, ...nap], 0)
    expect(out.slice(0, 420).every(r => r.block_type === 'primary')).toBe(true)
    expect(out.slice(420).every(r => r.block_type === 'microsleep')).toBe(true)
  })

  it('folds a one-minute deep fragment into light, but never a REM one', () => {
    const t = at('2026-06-17T23:00:00')
    const rows = [
      ...run(t, 30, 2),
      ...run(t + 30 * 60, 1, 1), // lone deep minute
      ...run(t + 31 * 60, 30, 2),
      ...run(t + 61 * 60, 1, 3), // lone REM minute
      ...run(t + 62 * 60, 400, 2),
    ]
    const out = classifyBlocks(rows, 0)
    expect(out[30]).toMatchObject({ quality: 2, source: 'bout_consolidated', confidence: CONF_BOUT })
    expect(out[61]).toMatchObject({ quality: 3, source: 'firmware' })
  })

  it('demotes a synthetic tail ending in the 07:00–14:00 band (Step 5.5)', () => {
    const fw = run(at('2026-06-18T00:00:00'), 450, 2) // 00:00–07:29 firmware
    const tail = run(at('2026-06-18T07:30:00'), 60, 2, 'envelope') // 07:30–08:29 fill
    const out = classifyBlocks([...fw, ...tail], 0)
    expect(out.slice(0, 450).every(r => r.block_type === 'primary')).toBe(true)
    expect(out.slice(450).every(r => r.block_type === 'secondary')).toBe(true)
  })

  it('demotes a synthetic head before the first firmware minute (Step 5.5b)', () => {
    const head = run(at('2026-06-17T22:00:00'), 60, 2, 'envelope') // drowsy fill
    const fw = run(at('2026-06-17T23:00:00'), 420, 2)
    const out = classifyBlocks([...head, ...fw], 0)
    expect(out.slice(0, 60).every(r => r.block_type === 'secondary')).toBe(true)
    expect(out.slice(60).every(r => r.block_type === 'primary')).toBe(true)
  })
})
