/**
 * Zod schema for structured threshold rules (spec §Rule schema).
 *
 * The `metric` enum is generated at module load from the frozen
 * `METRIC_METADATA` registry — only metrics with `exposure: 'full'` are
 * accepted. Rules referencing `collected_only` metrics can still ship
 * via `rawSql` + `exposureOverride: true` (see validator.ts).
 */

import type { MetricId } from '../core/metric_metadata'
import { z } from 'zod'
import { getExposedMetricIds } from '../core/metric_metadata'

/** Custom error class for rule-schema / validator failures. */
export class RuleValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuleValidationError'
  }
}

const exposedMetricIds = getExposedMetricIds() as [MetricId, ...MetricId[]]

export const WINDOWS = ['1h', '6h', '24h', '3d', '7d', '30d'] as const
export type Window = (typeof WINDOWS)[number]

export const AGGREGATIONS = ['avg', 'min', 'max', 'sum', 'last', 'count'] as const
export type Aggregation = (typeof AGGREGATIONS)[number]

export const COMPARES = [
  'less_than',
  'greater_than',
  /**
   * Inclusive, and necessary rather than cosmetic.
   *
   * D-E puts the stress flag at 66, which is also the lower rail of the Tense
   * zone (`tense >= 66`). With `greater_than` a reading of exactly 66 sits in
   * Tense on the chart and does not count toward the alert — the screen and
   * the rule would disagree at the boundary the user chose.
   */
  'greater_than_or_equal',
  'less_than_or_equal',
  'equals',
  'not_equals',
  'between',
] as const
export type Compare = (typeof COMPARES)[number]

export const SEVERITIES = ['info', 'warn', 'critical'] as const
export type Severity = (typeof SEVERITIES)[number]

/**
 * Physiological context the rule restricts its samples to (Sprint 5 §4).
 *
 * - `any`     — every sample in the window
 * - `asleep`  — samples falling inside a `v_sleep_session` interval
 * - `resting` — samples in a minute with zero steps
 *
 * Context is a JOIN, not a post-filter: "SpO₂ during sleep" means the
 * aggregate is computed over sleep samples only, not computed over
 * everything and then labelled.
 */
export const CONTEXTS = ['any', 'asleep', 'resting'] as const
export type RuleContext = (typeof CONTEXTS)[number]

const TargetAbsolute = z.object({
  type: z.literal('absolute'),
  value: z.number(),
})

const TargetBaselinePercent = z.object({
  type: z.literal('baseline_percent'),
  windowDays: z.number().int().positive(),
  percent: z.number().positive(),
})

const TargetBaselineStddev = z.object({
  type: z.literal('baseline_stddev'),
  windowDays: z.number().int().positive(),
  stddevs: z.number(),
})

const TargetRange = z.object({
  type: z.literal('range'),
  min: z.number(),
  max: z.number(),
})

/**
 * v0.2.0 (Sprint 5 §4, Ziva #1) — threshold read from KVStore at eval time
 * rather than baked into the rule.
 *
 * This is what makes the ⚙ sheet's promise real: the user drags a safe
 * level, the mutation writes `user:spo2SafeLevel`, and the SAME shipped
 * rule re-evaluates against the new number on the next batch. No recompile,
 * no per-user rule rows.
 *
 * `compare` is a single-member enum rather than omitted: the comparison is
 * fixed by the rule's own `compare` field, and a second knob here would let
 * an author write a rule whose two comparison directions disagree.
 */
const TargetUserSetting = z.object({
  type: z.literal('user_setting'),
  /** KVStore key suffix, e.g. `user:spo2SafeLevel`. See the namespace registry. */
  key: z.string().min(1),
  /** Used when the user has never set the value. */
  defaultValue: z.number(),
  compare: z.enum(['as_configured']).default('as_configured'),
})

/**
 * sprint6 §3 — a fixed offset from the user's OWN stored baseline.
 *
 * Distinct from `baseline_percent`/`baseline_stddev` in where the baseline
 * comes from, which matters more than it looks. Those two recompute a mean
 * inline over raw readings in the window. This one reads `user_baseline.p50`
 * — the stored, day-first, ≥20-day-gated percentile (principle 27). An HRV
 * drop of 10 ms is only meaningful against the number the user's screen also
 * calls "usual"; recomputing a different average here would let the rule and
 * the chart disagree about the same word.
 *
 * `direction` fixes the comparison, so the rule's own `compare` is ignored
 * for this target — `below` fires when the observed value sits at least
 * `offset` under p50, `above` when it sits at least `offset` over.
 *
 * `offsetKey` makes the offset user-configurable at eval time, the same
 * mechanism as `user_setting`: the compiled SQL binds a parameter and the
 * evaluator resolves it from KVStore per user. `offset` is the fallback when
 * the key is unset, and is required so a rule always has a defined threshold.
 */
const TargetBaselineOffset = z.object({
  type: z.literal('baseline_offset'),
  windowDays: z.number().int().positive(),
  /** Absolute units of the metric — ms for hrv_ms, °C for temp_c. */
  offset: z.number().positive(),
  direction: z.enum(['below', 'above']),
  /** KVStore key overriding `offset` at eval time. Registry-validated. */
  offsetKey: z.string().min(1).optional(),
})

export const TargetSchema = z.discriminatedUnion('type', [
  TargetAbsolute,
  TargetBaselinePercent,
  TargetBaselineStddev,
  TargetRange,
  TargetUserSetting,
  TargetBaselineOffset,
])
export type Target = z.infer<typeof TargetSchema>

export const ThrottleSchema = z
  .object({
    minGapMinutes: z.number().nonnegative().default(60),
    maxPerDay: z.number().int().positive().default(3),
  })
  .default({})

export type Throttle = z.infer<typeof ThrottleSchema>

/**
 * What a "sample" is when counting `consecutive` (sprint6 §3).
 *
 * `reading` (default, existing behaviour) counts adjacent raw readings.
 * `day` collapses to one value per LOCAL day first, then counts adjacent
 * days — so `consecutive: 3` means "three days running", not "three readings
 * in a row", which for an hourly metric could be three hours of one evening.
 *
 * Local means the user's own zone, resolved from their profile attribute.
 * Days are midnight-to-midnight in that zone, matching `user_baseline`
 * compute exactly: a rule and the baseline it compares against must not
 * disagree about what a day is.
 */
export const CADENCES = ['reading', 'day'] as const
export type RuleCadence = (typeof CADENCES)[number]

export const RuleSchema = z.object({
  id: z.string().min(1),
  brand: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  metric: z.enum(exposedMetricIds),
  window: z.enum(WINDOWS),
  aggregation: z.enum(AGGREGATIONS).default('avg'),
  compare: z.enum(COMPARES),
  /** Restrict samples to a physiological context. Default `any`. */
  context: z.enum(CONTEXTS).default('any'),
  /**
   * Require `n` ADJACENT breaching samples before the rule fires.
   *
   * Omitted or `1` means "any breach in the window", which the aggregate
   * path already expresses (e.g. `aggregation: 'min'` + `less_than`).
   * `>= 2` switches the compiler to run-length detection.
   */
  consecutive: z.number().int().min(1).optional(),
  /**
   * Unit `consecutive` counts in. Default `reading` — existing behaviour.
   *
   * `day` requires `consecutive >= 2` unless `allowSingleDay` is set: a
   * single-day rule with day cadence is just an aggregate over one day,
   * which the reading path already expresses more cheaply, and writing it
   * this way usually means the author meant "days running".
   */
  cadence: z.enum(CADENCES).default('reading'),
  /** Opt out of the `cadence: 'day'` ⇒ `consecutive >= 2` requirement. */
  allowSingleDay: z.boolean().optional(),
  /** KVStore key overriding `consecutive` at eval time (sprint6 §4). */
  consecutiveKey: z.string().min(1).optional(),
  target: TargetSchema,
  severity: z.enum(SEVERITIES),
  throttle: ThrottleSchema,
  rawSql: z.string().optional(),
  rawSqlParams: z.array(z.string()).optional(),
  /**
   * Required-true when `rawSql` references `collected_only` columns
   * (BP, vascular aging). Validator enforces.
   */
  exposureOverride: z.boolean().optional(),
})

export type Rule = z.infer<typeof RuleSchema>
