/**
 * Analytics query I/O schemas (spec.md §18 — AnalyticsQuerySchemas).
 *
 * Runtime zod schemas shared between the analytics engine and app
 * registries. Deliberately NOT re-exported from the root index — apps
 * import via the `@mongrov/types/analytics-queries` subpath so collab
 * consumers of the root entry stay zero-runtime.
 *
 * These double as test contracts (testing-infrastructure.md §Zod schemas as
 * test contracts): if a fixture stops parsing, either the fixture is stale
 * or the schema drifted, and CI fails rather than shipping the mismatch.
 *
 * Input schemas are flat objects with optional fields — no discriminated
 * unions — because the same shapes back LLM-facing tool definitions and
 * Apple Foundation Models cannot express unions in a tool schema
 * (analytics-ai-tools/spec.md §Starter tools).
 */

import { z } from 'zod'

/** Shared: a userId plus a bounded day window. */
function userDaysInput(maxDays: number) {
  return z.object({
    userId: z.string(),
    days: z.number().int().min(1).max(maxDays),
  })
}

/** Metrics exposed to cross-metric tools (`exposure: 'full'` only). */
export const ComparableMetric = z.enum([
  'hrv_ms',
  'sleep_total_minutes',
  'activity_steps',
])

// ─────────────────────────────────────────────────────────────────────────
// Per-metric series
// ─────────────────────────────────────────────────────────────────────────

export const HrvDailySchemas = {
  input: userDaysInput(90),
  output: z.object({
    dailyAverages: z.array(
      z.object({
        day: z.string(),
        hrvMs: z.number(),
      }),
    ),
    /** Null until the baseline matures (20 days minimum, principle 27). */
    baseline: z
      .object({
        mean: z.number(),
        p10: z.number(),
        p90: z.number(),
        computedAt: z.string(),
      })
      .nullable(),
  }),
} as const

/**
 * Daily temperature for `getTemperature` (sprint6 §6).
 *
 * Values are canonical °C. `unit` is carried explicitly rather than assumed:
 * the ring reports Celsius, the user may read Fahrenheit, and a number whose
 * unit is inferred at the far end is how 37.5 becomes a fever in one locale
 * and a shrug in another.
 *
 * `precision` is what the DEVICE reports, not what the column stores —
 * `temperature.temp_c` is DECIMAL(4,1) while today's ring emits whole
 * degrees. A formatter that prints one decimal off a 1.0-precision reading
 * is inventing detail the hardware never measured.
 */
export const TempDailySchemas = {
  input: userDaysInput(90),
  output: z.object({
    daily: z.array(
      z.object({
        day: z.string(),
        avgTempC: z.number(),
        hiTempC: z.number(),
        loTempC: z.number(),
      }),
    ),
    /** The user's own usual range, absent until the 20-day gate passes. */
    baseline: z
      .object({
        p10: z.number(),
        p50: z.number(),
        p90: z.number(),
        computedAt: z.string(),
      })
      .nullable(),
    unit: z.literal('C'),
    precision: z.number(),
  }),
} as const

export const SpO2NightlySchemas = {
  input: userDaysInput(90),
  output: z.object({
    nightlyAverages: z.array(
      z.object({
        nightOf: z.string(),
        avgSpo2: z.number(),
        minSpo2: z.number(),
        /**
         * Internal name only. Formatters must render this as "brief low
         * moments" or similar — the medical term for it is on the banned
         * vocabulary list (principle 37).
         */
        lowMomentCount: z.number(),
      }),
    ),
    baseline: z
      .object({
        p50: z.number(),
        p10: z.number(),
        p05: z.number(),
        computedAt: z.string(),
      })
      .nullable(),
  }),
} as const

export const SleepSummarySchemas = {
  input: userDaysInput(90),
  output: z.object({
    nights: z.array(
      z.object({
        nightOf: z.string(),
        totalMinutes: z.number(),
        deepMinutes: z.number().nullable(),
        remMinutes: z.number().nullable(),
        lightMinutes: z.number().nullable(),
        awakeMinutes: z.number().nullable(),
        avgConfidence: z.number().nullable(),
      }),
    ),
    avgTotalMinutes: z.number().nullable(),
  }),
} as const

export const ActivityTotalSchemas = {
  input: userDaysInput(90),
  output: z.object({
    days: z.array(
      z.object({
        day: z.string(),
        steps: z.number(),
        calories: z.number().nullable(),
        distanceKm: z.number().nullable(),
      }),
    ),
    totalSteps: z.number(),
    avgStepsPerDay: z.number().nullable(),
  }),
} as const

// ─────────────────────────────────────────────────────────────────────────
// Cross-window analysis
// ─────────────────────────────────────────────────────────────────────────

export const CompareTrendSchemas = {
  input: z.object({
    userId: z.string(),
    metric: ComparableMetric,
    currentWindowDays: z.number().int().min(1).max(30),
    priorWindowDays: z.number().int().min(1).max(30),
  }),
  output: z.object({
    metric: ComparableMetric,
    currentValue: z.number().nullable(),
    priorValue: z.number().nullable(),
    /** Null when the prior window is empty or zero — never Infinity/NaN. */
    deltaPercent: z.number().nullable(),
    direction: z.enum(['up', 'down', 'flat', 'unknown']),
  }),
} as const

export const DetectAnomalySchemas = {
  input: z.object({
    userId: z.string(),
    metric: ComparableMetric,
    lookbackDays: z.number().int().min(7).max(90),
    stddevThreshold: z.number().min(1).max(4).default(2),
  }),
  output: z.object({
    metric: ComparableMetric,
    anomalies: z.array(
      z.object({
        day: z.string(),
        value: z.number(),
        stddevsFromMean: z.number(),
      }),
    ),
    mean: z.number().nullable(),
    stddev: z.number().nullable(),
  }),
} as const

// ─────────────────────────────────────────────────────────────────────────
// Insights
// ─────────────────────────────────────────────────────────────────────────

/**
 * Insight severity. This is the `insight` table's enum
 * (`info | warn | urgent`), which is intentionally NOT the rule schema's
 * (`info | warn | critical`) — the rules evaluator maps `critical → urgent`
 * on write.
 */
export const InsightSeverity = z.enum(['info', 'warn', 'urgent'])

export const GetInsightsSchemas = {
  input: z.object({
    userId: z.string(),
    days: z.number().int().min(1).max(30).default(7),
    severity: InsightSeverity.optional(),
  }),
  output: z.object({
    insights: z.array(
      z.object({
        insightId: z.string(),
        metric: z.string(),
        kind: z.enum(['threshold', 'pattern', 'baseline_shift', 'factor']),
        severity: InsightSeverity,
        title: z.string(),
        body: z.string().nullable(),
        firedAt: z.string(),
      }),
    ),
  }),
} as const

// ─────────────────────────────────────────────────────────────────────────
// Family aggregate
// ─────────────────────────────────────────────────────────────────────────

export const FamilyHrvTodaySchemas = {
  input: z.object({ familyId: z.string() }),
  output: z.object({
    members: z.array(
      z.object({
        userId: z.string(),
        displayName: z.string().nullable(),
        hrvMs: z.number().nullable(),
      }),
    ),
    familyAvgHrvMs: z.number().nullable(),
  }),
} as const

// ─────────────────────────────────────────────────────────────────────────
// Aggregate export + inferred types
// ─────────────────────────────────────────────────────────────────────────

/**
 * Every query schema pair, keyed by name. Both
 * `@mongrov/analytics/tools` and app registries reference these same
 * objects so drift in one surfaces as a type error in the other.
 */
export const AnalyticsQuerySchemas = {
  HrvDailySchemas,
  SpO2NightlySchemas,
  TempDailySchemas,
  SleepSummarySchemas,
  ActivityTotalSchemas,
  CompareTrendSchemas,
  DetectAnomalySchemas,
  GetInsightsSchemas,
  FamilyHrvTodaySchemas,
} as const

export type HrvDailyInput = z.infer<typeof HrvDailySchemas.input>
export type HrvDailyOutput = z.infer<typeof HrvDailySchemas.output>
export type TempDailyInput = z.infer<typeof TempDailySchemas.input>
export type TempDailyOutput = z.infer<typeof TempDailySchemas.output>
export type SpO2NightlyInput = z.infer<typeof SpO2NightlySchemas.input>
export type SpO2NightlyOutput = z.infer<typeof SpO2NightlySchemas.output>
export type SleepSummaryInput = z.infer<typeof SleepSummarySchemas.input>
export type SleepSummaryOutput = z.infer<typeof SleepSummarySchemas.output>
export type ActivityTotalInput = z.infer<typeof ActivityTotalSchemas.input>
export type ActivityTotalOutput = z.infer<typeof ActivityTotalSchemas.output>
export type CompareTrendInput = z.infer<typeof CompareTrendSchemas.input>
export type CompareTrendOutput = z.infer<typeof CompareTrendSchemas.output>
export type DetectAnomalyInput = z.infer<typeof DetectAnomalySchemas.input>
export type DetectAnomalyOutput = z.infer<typeof DetectAnomalySchemas.output>
export type GetInsightsInput = z.infer<typeof GetInsightsSchemas.input>
export type GetInsightsOutput = z.infer<typeof GetInsightsSchemas.output>
export type FamilyHrvTodayInput = z.infer<typeof FamilyHrvTodaySchemas.input>
export type FamilyHrvTodayOutput = z.infer<typeof FamilyHrvTodaySchemas.output>
