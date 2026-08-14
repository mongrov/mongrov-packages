/**
 * AnalyticsQuerySchemas — the shared I/O contract between
 * `@mongrov/analytics/tools` and app registries.
 *
 * testing-infrastructure.md §"Zod schemas as test contracts": these schemas
 * double as parse-checks in downstream unit tests, so a round-trip failure
 * here means either a fixture is stale or the schema drifted.
 */

import {
  ActivityTotalSchemas,
  AnalyticsQuerySchemas,
  CompareTrendSchemas,
  DetectAnomalySchemas,
  FamilyHrvTodaySchemas,
  GetInsightsSchemas,
  HrvDailySchemas,
  SleepSummarySchemas,
  SpO2NightlySchemas,
} from '../analytics-queries'

describe('AnalyticsQuerySchemas', () => {
  it('exports every schema pair named in spec.md §18', () => {
    expect(Object.keys(AnalyticsQuerySchemas).sort()).toEqual([
      'ActivityTotalSchemas',
      'CompareTrendSchemas',
      'DetectAnomalySchemas',
      'FamilyHrvTodaySchemas',
      'GetInsightsSchemas',
      'HrvDailySchemas',
      'SleepSummarySchemas',
      'SpO2NightlySchemas',
      'TempDailySchemas',
    ])
  })

  it('every entry exposes both an input and an output schema', () => {
    const missing = Object.entries(AnalyticsQuerySchemas)
      .filter(([, pair]) => !('input' in pair) || !('output' in pair))
      .map(([name]) => name)
    expect(missing).toEqual([])
  })

  it('input schemas are flat objects — no unions (Apple FM constraint)', () => {
    // analytics-ai-tools/spec.md §Starter tools: these shapes back
    // LLM-facing tool definitions, and Apple Foundation Models cannot
    // express a discriminated union in a tool schema.
    const nonObject = Object.entries(AnalyticsQuerySchemas)
      .filter(([, pair]) => pair.input._def.typeName !== 'ZodObject')
      .map(([name]) => name)
    expect(nonObject).toEqual([])
  })
})

describe('input validation', () => {
  it('bounds day windows and rejects out-of-range values', () => {
    expect(HrvDailySchemas.input.safeParse({ userId: 'u', days: 7 }).success)
      .toBe(true)
    expect(HrvDailySchemas.input.safeParse({ userId: 'u', days: 0 }).success)
      .toBe(false)
    expect(HrvDailySchemas.input.safeParse({ userId: 'u', days: 91 }).success)
      .toBe(false)
    expect(HrvDailySchemas.input.safeParse({ userId: 'u', days: 1.5 }).success)
      .toBe(false)
  })

  it('applies documented defaults', () => {
    const anomaly = DetectAnomalySchemas.input.parse({
      userId: 'u',
      metric: 'hrv_ms',
      lookbackDays: 30,
    })
    expect(anomaly.stddevThreshold).toBe(2)

    const insights = GetInsightsSchemas.input.parse({ userId: 'u' })
    expect(insights.days).toBe(7)
  })

  it('restricts cross-metric tools to exposure:full metrics', () => {
    // BP + vascular aging are collected_only and must never be addressable
    // from a tool input (principle 23).
    expect(
      CompareTrendSchemas.input.safeParse({
        userId: 'u',
        metric: 'systolic_bp',
        currentWindowDays: 7,
        priorWindowDays: 7,
      }).success,
    ).toBe(false)
    expect(
      CompareTrendSchemas.input.safeParse({
        userId: 'u',
        metric: 'hrv_ms',
        currentWindowDays: 7,
        priorWindowDays: 7,
      }).success,
    ).toBe(true)
  })
})

describe('output round-trips', () => {
  it('HrvDaily accepts a null baseline before maturity', () => {
    const parsed = HrvDailySchemas.output.parse({
      dailyAverages: [{ day: '2026-07-01', hrvMs: 45 }],
      baseline: null,
    })
    expect(parsed.baseline).toBeNull()
  })

  it('SpO2Nightly keeps the internal lowMomentCount name', () => {
    // Sprint 5 T-28: the type-level name stays neutral; formatters are the
    // layer that renders it as "brief low moments".
    const parsed = SpO2NightlySchemas.output.parse({
      nightlyAverages: [
        { nightOf: '2026-07-01', avgSpo2: 96, minSpo2: 89, lowMomentCount: 2 },
      ],
      baseline: { p50: 96, p10: 94, p05: 93, computedAt: '2026-07-02T00:00:00Z' },
    })
    expect(parsed.nightlyAverages[0].lowMomentCount).toBe(2)
  })

  it('SleepSummary allows null stage breakdowns', () => {
    const parsed = SleepSummarySchemas.output.parse({
      nights: [
        {
          nightOf: '2026-07-01',
          totalMinutes: 420,
          deepMinutes: null,
          remMinutes: null,
          lightMinutes: null,
          awakeMinutes: null,
          avgConfidence: null,
        },
      ],
      avgTotalMinutes: 420,
    })
    expect(parsed.nights[0].totalMinutes).toBe(420)
  })

  it('CompareTrend expresses an empty prior window as null, not Infinity', () => {
    const parsed = CompareTrendSchemas.output.parse({
      metric: 'hrv_ms',
      currentValue: 45,
      priorValue: null,
      deltaPercent: null,
      direction: 'unknown',
    })
    expect(parsed.deltaPercent).toBeNull()
    expect(Number.isFinite(parsed.deltaPercent as unknown as number)).toBe(false)
  })

  it('GetInsights uses the insight table severity enum, not the rule enum', () => {
    // The rule schema's tier is `critical`; the table's is `urgent`. The
    // evaluator maps between them, so the query contract must speak the
    // table's enum.
    expect(
      GetInsightsSchemas.input.safeParse({ userId: 'u', severity: 'urgent' })
        .success,
    ).toBe(true)
    expect(
      GetInsightsSchemas.input.safeParse({ userId: 'u', severity: 'critical' })
        .success,
    ).toBe(false)
  })

  it('ActivityTotal and FamilyHrvToday round-trip', () => {
    expect(
      ActivityTotalSchemas.output.parse({
        days: [{ day: '2026-07-01', steps: 8000, calories: 320, distanceKm: 6.1 }],
        totalSteps: 8000,
        avgStepsPerDay: 8000,
      }).totalSteps,
    ).toBe(8000)

    expect(
      FamilyHrvTodaySchemas.output.parse({
        members: [{ userId: 'u1', displayName: 'Alice', hrvMs: 45 }],
        familyAvgHrvMs: 45,
      }).members,
    ).toHaveLength(1)
  })
})
