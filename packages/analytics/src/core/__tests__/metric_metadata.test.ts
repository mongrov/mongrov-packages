import { describe, expect, it } from 'vitest'

import {
  getExposedMetricIds,
  isMetricExposed,
  METRIC_METADATA,
  type MetricId,
} from '../metric_metadata'
import { TABLE_NAMES } from '../schemas'

const METRIC_IDS = Object.keys(METRIC_METADATA) as MetricId[]

describe('METRIC_METADATA', () => {
  it('has the 14 metrics from spec §Metric metadata', () => {
    expect(METRIC_IDS).toHaveLength(14)
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
  it('returns 11 exposed metric ids (14 total minus 3 collected_only)', () => {
    const exposed = getExposedMetricIds()
    expect(exposed).toHaveLength(11)
    expect(exposed).not.toContain('systolic_bp')
    expect(exposed).not.toContain('diastolic_bp')
    expect(exposed).not.toContain('vascular_aging')
  })
})
