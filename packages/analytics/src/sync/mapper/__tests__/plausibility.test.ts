/**
 * zivaone_app#225 — filler samples must not reach the warehouse.
 *
 * The real incident: a temperature page carried `6537.8 °C` (65378 read
 * unsigned) and timestamps eight years out, both from 0xFF padding at the end
 * of a page. The value failed the DECIMAL(4,1) cast and took all 662 rows of
 * that sync with it.
 */

import { describe, expect, it } from 'vitest'

import {
  dropImplausibleRows,
  MAX_CLOCK_AHEAD_DAYS,
} from '../plausibility'

const NOW = new Date('2026-09-21T12:00:00.000Z')

function tempRow(tempC: number, iso = '2026-09-21T04:00:00.000Z') {
  return { ts: new Date(iso), temp_c: tempC }
}

describe('dropImplausibleRows', () => {
  it('drops the filler sample and keeps the readings around it', () => {
    const report = dropImplausibleRows('temperature', [
      tempRow(36.2),
      tempRow(6537.800293), // the value the ring actually sent
      tempRow(36.4),
    ], NOW)

    expect(report.dropped).toBe(1)
    expect(report.kept.map(r => r.temp_c)).toEqual([36.2, 36.4])
    expect(report.sample).toMatch(/6537\.8/)
  })

  it('drops a negative sample too, which is what the value really was', () => {
    // 65378 as a signed int16 is -158, i.e. -15.8 °C. That FITS DECIMAL(4,1),
    // so reading the value signed without this bound would store it silently
    // and surface it on a card instead of failing loudly.
    const report = dropImplausibleRows('temperature', [tempRow(-15.8)], NOW)
    expect(report.dropped).toBe(1)
    expect(report.kept).toEqual([])
  })

  it('drops the 2034 filler timestamp, whose SHAPE is perfectly valid', () => {
    const report = dropImplausibleRows(
      'temperature',
      [tempRow(36.5, '2034-01-30T01:30:01.000Z')],
      NOW,
    )
    expect(report.dropped).toBe(1)
    expect(report.sample).toMatch(/believable window/)
  })

  it('keeps a reading from a ring whose clock runs weeks fast', () => {
    // Ordinary and observed: rings drift ahead, and "this week"/"this month"
    // run to their end, so a reading dropped here would be missing from a
    // window that legitimately covers it.
    const ahead = new Date(NOW.getTime() + 20 * 86_400_000).toISOString()
    const report = dropImplausibleRows('temperature', [tempRow(36.5, ahead)], NOW)
    expect(report.dropped).toBe(0)
    expect(report.kept).toHaveLength(1)
  })

  it('draws the future line where the constant says', () => {
    const justInside = new Date(NOW.getTime() + (MAX_CLOCK_AHEAD_DAYS - 1) * 86_400_000).toISOString()
    const justOutside = new Date(NOW.getTime() + (MAX_CLOCK_AHEAD_DAYS + 1) * 86_400_000).toISOString()
    expect(dropImplausibleRows('temperature', [tempRow(36.5, justInside)], NOW).dropped).toBe(0)
    expect(dropImplausibleRows('temperature', [tempRow(36.5, justOutside)], NOW).dropped).toBe(1)
  })

  it('guards the other reading tables on their own ranges', () => {
    expect(dropImplausibleRows('spo2', [{ ts: NOW, spo2: 50 }], NOW).dropped).toBe(1)
    expect(dropImplausibleRows('spo2', [{ ts: NOW, spo2: 97 }], NOW).dropped).toBe(0)
    expect(dropImplausibleRows('heart_rate', [{ ts: NOW, bpm: 0 }], NOW).dropped).toBe(1)
  })

  // Spec §13b: plausibility is per vital, not per row. The canonical fixture
  // (techspec firmware-dirty-readings.json) keeps "10:00 HRV 0 ... its stress
  // 35 stays clean".
  it('nulls an implausible HRV and keeps the row, so its stress survives', () => {
    const report = dropImplausibleRows('hrv', [
      { ts: NOW, hrv_ms: 0, stress: 35 },
      { ts: NOW, hrv_ms: 4, stress: 40 },
      { ts: NOW, hrv_ms: 50, stress: 20 },
      { ts: NOW, hrv_ms: 250, stress: 22 },
    ], NOW)
    expect(report.dropped).toBe(0)
    expect(report.nulled).toBe(3)
    expect(report.kept).toEqual([
      { ts: NOW, hrv_ms: null, stress: 35 },
      { ts: NOW, hrv_ms: null, stress: 40 },
      { ts: NOW, hrv_ms: 50, stress: 20 },
      { ts: NOW, hrv_ms: null, stress: 22 },
    ])
    expect(report.sample).toBe('hrv_ms=0 outside [5, 200], set to NULL')
  })

  it('keeps an HRV row whose reading is already NULL, without counting it', () => {
    const report = dropImplausibleRows('hrv', [{ ts: NOW, hrv_ms: null, stress: 35 }], NOW)
    expect(report).toEqual({ kept: [{ ts: NOW, hrv_ms: null, stress: 35 }], dropped: 0, nulled: 0 })
  })

  it('still drops an HRV row whose timestamp is implausible', () => {
    const report = dropImplausibleRows('hrv', [
      { ts: new Date('2019-12-31T23:59:00.000Z'), hrv_ms: 50, stress: 20 },
      { ts: new Date('2019-12-31T23:59:00.000Z'), hrv_ms: 0, stress: 20 },
    ], NOW)
    expect(report.kept).toEqual([])
    expect(report.dropped).toBe(2)
    expect(report.nulled).toBe(0)
  })

  it('the other reading tables never null, they drop', () => {
    const report = dropImplausibleRows('heart_rate', [{ ts: NOW, bpm: 0 }], NOW)
    expect(report.nulled).toBe(0)
    expect(report.dropped).toBe(1)
  })

  it('leaves tables it does not guard completely alone', () => {
    // activity and sleep carry no single reading value; passing them through
    // untouched is the point, not an oversight.
    const rows = [{ ts: NOW, steps: 120 }, { ts: NOW, steps: 999_999 }]
    const report = dropImplausibleRows('activity', rows, NOW)
    expect(report.dropped).toBe(0)
    expect(report.kept).toHaveLength(2)
  })

  it('reports nothing when every row is believable', () => {
    const report = dropImplausibleRows('temperature', [tempRow(36.1), tempRow(36.9)], NOW)
    expect(report.dropped).toBe(0)
    expect(report.sample).toBeUndefined()
  })
})
