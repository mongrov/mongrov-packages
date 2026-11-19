/**
 * Ingest keeps every reading and drops only rows that are not readings
 * (sprint6 spec §13 amendment 2026-11-12, S10 "flag, don't delete"; T-60).
 *
 * The history this guards: zivaone_app#225, a temperature page carried
 * `6537.8 °C` (65378 read unsigned) and timestamps eight years out, both from
 * 0xFF padding at the end of a page. The value failed the DECIMAL(4,1) cast
 * and took all 662 rows of that sync with it. Those two stay dropped. A value
 * that is merely outside the §13b clamps is now stored, and `v_*_q.plausible`
 * flags it.
 */

import { describe, expect, it } from 'vitest'

import {
  dropImplausibleRows,
  dropMalformedRows,
  DropTally,
  MAX_CLOCK_AHEAD_DAYS,
} from '../../../__tests__/packs/health/plausibility'

const NOW = new Date('2026-09-21T12:00:00.000Z')

function tempRow(tempC: number | null, iso = '2026-09-21T04:00:00.000Z') {
  return { ts: new Date(iso), temp_c: tempC }
}

describe('dropMalformedRows — out-of-range readings are stored (S10)', () => {
  it('keeps HR 250 and SpO2 40: flagged later by v_*_q, not dropped here', () => {
    expect(dropMalformedRows('heart_rate', [{ ts: NOW, bpm: 250 }], NOW))
      .toEqual({ kept: [{ ts: NOW, bpm: 250 }], dropped: 0, reasons: {}, nulled: 0 })
    expect(dropMalformedRows('spo2', [{ ts: NOW, spo2: 40 }], NOW).kept).toEqual([{ ts: NOW, spo2: 40 }])
  })

  it('keeps the -15.8 °C wrapped sample and the 36.5 °C 10x one, for the views to flag', () => {
    const report = dropMalformedRows('temperature', [tempRow(-15.8), tempRow(365), tempRow(36.4)], NOW)
    expect(report.dropped).toBe(0)
    expect(report.kept.map(r => r.temp_c)).toEqual([-15.8, 365, 36.4])
  })

  it('keeps an out-of-range HRV as it is (4 ms, 250 ms): only the 0 sentinel is nulled', () => {
    const report = dropMalformedRows('hrv', [
      { ts: NOW, hrv_ms: 0, stress: 35 },
      { ts: NOW, hrv_ms: 4, stress: 40 },
      { ts: NOW, hrv_ms: 50, stress: 20 },
      { ts: NOW, hrv_ms: 250, stress: 22 },
    ], NOW)
    expect(report.dropped).toBe(0)
    expect(report.nulled).toBe(1)
    expect(report.kept).toEqual([
      { ts: NOW, hrv_ms: null, stress: 35 },
      { ts: NOW, hrv_ms: 4, stress: 40 },
      { ts: NOW, hrv_ms: 50, stress: 20 },
      { ts: NOW, hrv_ms: 250, stress: 22 },
    ])
    expect(report.sample).toBe('hrv_ms=0 is the no-value sentinel, set to NULL')
  })

  it('the old name is the same function', () => {
    expect(dropImplausibleRows).toBe(dropMalformedRows)
  })
})

describe('dropMalformedRows — malformed rows are dropped, by reason', () => {
  it('drops a 1970 timestamp (reset clock) as before_epoch', () => {
    const report = dropMalformedRows('heart_rate', [
      { ts: new Date(0), bpm: 62 },
      { ts: NOW, bpm: 64 },
    ], NOW)
    expect(report.kept).toEqual([{ ts: NOW, bpm: 64 }])
    expect(report.dropped).toBe(1)
    expect(report.reasons).toEqual({ before_epoch: 1 })
    expect(report.sample).toMatch(/1970-01-01.*before 2020-01-01/)
  })

  it('drops the 2034 filler timestamp, whose SHAPE is perfectly valid, as future', () => {
    const report = dropMalformedRows('temperature', [tempRow(36.5, '2034-01-30T01:30:01.000Z')], NOW)
    expect(report.reasons).toEqual({ future: 1 })
  })

  it('keeps a reading from a ring whose clock runs weeks fast', () => {
    const ahead = new Date(NOW.getTime() + 20 * 86_400_000).toISOString()
    expect(dropMalformedRows('temperature', [tempRow(36.5, ahead)], NOW).dropped).toBe(0)
  })

  it('draws the future line where the constant says', () => {
    const justInside = new Date(NOW.getTime() + (MAX_CLOCK_AHEAD_DAYS - 1) * 86_400_000).toISOString()
    const justOutside = new Date(NOW.getTime() + (MAX_CLOCK_AHEAD_DAYS + 1) * 86_400_000).toISOString()
    expect(dropMalformedRows('temperature', [tempRow(36.5, justInside)], NOW).dropped).toBe(0)
    expect(dropMalformedRows('temperature', [tempRow(36.5, justOutside)], NOW).dropped).toBe(1)
  })

  it('drops a missing or unparseable timestamp as bad_timestamp', () => {
    const report = dropMalformedRows('spo2', [
      { spo2: 97 },
      { ts: 'not a date', spo2: 97 },
      { ts: new Date(Number.NaN), spo2: 97 },
    ], NOW)
    expect(report.kept).toEqual([])
    expect(report.reasons).toEqual({ bad_timestamp: 3 })
  })

  it('drops a value the column cannot store (the #225 6537.8 °C) as undecodable', () => {
    const report = dropMalformedRows('temperature', [tempRow(36.2), tempRow(6537.800293), tempRow(36.4)], NOW)
    expect(report.kept.map(r => r.temp_c)).toEqual([36.2, 36.4])
    expect(report.reasons).toEqual({ undecodable: 1 })
    expect(report.sample).toMatch(/6537\.8/)
  })

  it('drops a non-numeric value as undecodable', () => {
    const report = dropMalformedRows('heart_rate', [{ ts: NOW, bpm: 'abc' }, { ts: NOW, bpm: Number.POSITIVE_INFINITY }], NOW)
    expect(report.reasons).toEqual({ undecodable: 2 })
  })

  it('drops the 0 "no value" sentinel and a NULL on single-reading tables as no_value', () => {
    expect(dropMalformedRows('heart_rate', [{ ts: NOW, bpm: 0 }], NOW).reasons).toEqual({ no_value: 1 })
    expect(dropMalformedRows('spo2', [{ ts: NOW, spo2: 0 }], NOW).reasons).toEqual({ no_value: 1 })
    expect(dropMalformedRows('temperature', [tempRow(null)], NOW).reasons).toEqual({ no_value: 1 })
  })

  it('on hrv a bad value is nulled, never a row drop; a bad timestamp still drops it', () => {
    const report = dropMalformedRows('hrv', [
      { ts: NOW, hrv_ms: 'x', stress: 30 },
      { ts: new Date('2019-12-31T23:59:00.000Z'), hrv_ms: 50, stress: 20 },
    ], NOW)
    expect(report.kept).toEqual([{ ts: NOW, hrv_ms: null, stress: 30 }])
    expect(report.nulled).toBe(1)
    expect(report.reasons).toEqual({ before_epoch: 1 })
  })

  it('keeps an HRV row whose reading is already NULL, without counting it', () => {
    const report = dropMalformedRows('hrv', [{ ts: NOW, hrv_ms: null, stress: 35 }], NOW)
    expect(report).toEqual({ kept: [{ ts: NOW, hrv_ms: null, stress: 35 }], dropped: 0, reasons: {}, nulled: 0 })
  })

  it('leaves tables it does not guard completely alone', () => {
    const rows = [{ ts: NOW, steps: 120 }, { steps: 999_999 }]
    const report = dropMalformedRows('activity', rows, NOW)
    expect(report.dropped).toBe(0)
    expect(report.kept).toHaveLength(2)
  })

  it('reports nothing when every row is well formed', () => {
    const report = dropMalformedRows('temperature', [tempRow(36.1), tempRow(36.9)], NOW)
    expect(report.dropped).toBe(0)
    expect(report.sample).toBeUndefined()
  })
})

describe('dropTally', () => {
  it('sums by table and reason across chunks and resets on drain', () => {
    const tally = new DropTally()
    tally.add('heart_rate', dropMalformedRows('heart_rate', [{ ts: new Date(0), bpm: 60 }, { ts: NOW, bpm: 0 }], NOW))
    tally.add('heart_rate', dropMalformedRows('heart_rate', [{ ts: new Date(0), bpm: 61 }], NOW))
    tally.add('hrv', dropMalformedRows('hrv', [{ ts: NOW, hrv_ms: 0, stress: 1 }], NOW))
    tally.add('spo2', dropMalformedRows('spo2', [{ ts: NOW, spo2: 40 }], NOW))

    expect(tally.drain()).toEqual({
      dropped: { heart_rate: { before_epoch: 2, no_value: 1 } },
      nulled: { hrv: 1 },
      total: 3,
      samples: {
        heart_rate: expect.stringMatching(/before 2020/),
        hrv: expect.stringMatching(/set to NULL/),
      },
    })
    expect(tally.drain()).toBeUndefined()
  })
})
