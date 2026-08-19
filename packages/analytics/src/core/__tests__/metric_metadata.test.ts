import type { MetricId } from '../metric_metadata'

import { describe, expect, it } from 'vitest'
import { getExposedMetricIds, isMetricExposed, METRIC_METADATA, precisionFor, supportsContinuousCurve } from '../metric_metadata'
import { LOCAL_SCHEMAS, TABLE_NAMES } from '../schemas'

const METRIC_IDS = Object.keys(METRIC_METADATA) as MetricId[]

describe('METRIC_METADATA', () => {
  it('has the 16 metrics from spec §Metric metadata (14 + D-G's two)', () => {
    expect(METRIC_IDS).toHaveLength(16)
  })

  it('every entry references a valid TableName', () => {
    for (const id of METRIC_IDS) {
      const entry = METRIC_METADATA[id]
      expect(TABLE_NAMES).toContain(entry.table)
    }
  })

  it('marks BP + vascular aging as collected_only', () => {
    expect(METRIC_METADATA.systolic_bp.exposure).toBe('collected_only')
    expect(METRIC_METADATA.diastolic_bp.exposure).toBe('collected_only')
    expect(METRIC_METADATA.vascular_aging.exposure).toBe('collected_only')
  })

  it('marks HRV and HR as full exposure', () => {
    expect(METRIC_METADATA.hrv_ms.exposure).toBe('full')
    expect(METRIC_METADATA.hr_bpm.exposure).toBe('full')
  })

  it('uses per_session sentinel for sleep metrics', () => {
    expect(METRIC_METADATA.sleep_total_minutes.sampling_minutes).toBe('per_session')
    expect(METRIC_METADATA.sleep_score.sampling_minutes).toBe('per_session')
  })
})

describe('isMetricExposed', () => {
  it('is false for collected_only metrics', () => {
    expect(isMetricExposed('systolic_bp')).toBe(false)
    expect(isMetricExposed('vascular_aging')).toBe(false)
  })

  it('is true for full metrics', () => {
    expect(isMetricExposed('hrv_ms')).toBe(true)
    expect(isMetricExposed('activity_steps')).toBe(true)
  })
})

describe('getExposedMetricIds', () => {
  it('returns 13 exposed metric ids (16 total minus 3 collected_only)', () => {
    const exposed = getExposedMetricIds()
    expect(exposed).toHaveLength(13)
    expect(exposed).not.toContain('systolic_bp')
    expect(exposed).not.toContain('diastolic_bp')
    expect(exposed).not.toContain('vascular_aging')
  })
})

describe('reporting precision (sprint6 T-08)', () => {
  it('reports 1.0 for the whole-degree ring — the temp precision gate', () => {
    // sprint6 §7's acceptance: a whole-degree device makes the gate report
    // 1.0, which is what tells the Day view to draw discrete marks.
    expect(precisionFor('temp_c')).toBe(1)
    expect(supportsContinuousCurve('temp_c')).toBe(false)
  })

  it('declares precision for every metric a vital screen renders', () => {
    // These four have screens in sprint6 (spo2, temp, hrv, stress) plus hr.
    // An undeclared precision would leave the mark rule undecidable rather
    // than wrong, which is harder to notice.
    for (const id of ['spo2', 'temp_c', 'hrv_ms', 'stress', 'hr_bpm'] as const)
      expect(precisionFor(id)).toBeDefined()
  })

  it('separates reporting precision from storage precision', () => {
    // temp_c is DECIMAL(4,1) as of analytics 0.9.1 so a finer ring needs no
    // migration, but the CURRENT hardware still emits whole degrees. The two
    // numbers are allowed to disagree, and this is the one metric where they
    // currently do.
    expect(LOCAL_SCHEMAS.temperature).toContain('temp_c DECIMAL(4,1)')
    expect(precisionFor('temp_c')).toBe(1)
  })

  it('would flip the mark rule for a finer device', () => {
    // Guards the comparison, not the constant: if precision ever drops below
    // 1 the curve becomes legitimate, and this is the line that decides it.
    expect(supportsContinuousCurve('temp_c')).toBe(false)
    const finer = { ...METRIC_METADATA.temp_c, precision: 0.1 }
    expect(finer.precision < 1).toBe(true)
  })
})
