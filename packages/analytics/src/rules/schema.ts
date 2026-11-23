/**
 * Zod schema for structured threshold rules (spec §Rule schema).
 *
 * The `metric` enum is generated at module load from the frozen
 * `METRIC_METADATA` registry — only metrics with `exposure: 'full'` are
 * accepted. Rules referencing `collected_only` metrics can still ship
 * via `rawSql` + `exposureOverride: true` (see validator.ts).
 */

import { z } from 'zod'
import { exposedMetricIds } from '../core/metrics'
import { ruleContextNames } from './contexts'

/** Custom error class for rule-schema / validator failures. */
export class RuleValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuleValidationError'
  }
}

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
   * A flag at 66 that is also, the lower rail of a zone
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
 * The context a rule restricts its samples to (Sprint 5 §4): `any` (every
 * sample in the window), or one a pack registers (`pack.rules.contexts`).
 *
 * Context is a JOIN, not a post-filter: "a reading during X" means the
 * aggregate is computed over those samples only, not computed over
 * everything and then labelled.
 */
export type RuleContext = string

/**
 * Checked when a rule is parsed, against the packs registered then — not
 * when this module loads, which may be before the app registers its packs.
 */
function oneOf(names: () => string[]) {
  return (value: string, ctx: z.RefinementCtx) => {
    const options = names()
    if (!options.includes(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.invalid_enum_value,
        options,
        received: value,
        message: `Invalid enum value. Expected ${options.map(o => `'${o}'`).join(' | ')}, received '${value}'`,
      })
    }
  }
}

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
 * v0.2.0 (Sprint 5 §4) — threshold read from KVStore at eval time
 * rather than baked into the rule.
 *
 * This is what makes the ⚙ sheet's promise real: the user drags a safe
 * level, the mutation writes `user:safeLevel`, and the SAME shipped
 * rule re-evaluates against the new number on the next batch. No recompile,
 * no per-user rule rows.
 *
 * `compare` is a single-member enum rather than omitted: the comparison is
 * fixed by the rule's own `compare` field, and a second knob here would let
 * an author write a rule whose two comparison directions disagree.
 */
const TargetUserSetting = z.object({
  type: z.literal('user_setting'),
  /** KVStore key suffix, e.g. `user:safeLevel`. See the namespace registry. */
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
 * — the stored, day-first, ≥20-day-gated percentile (principle 27). A
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
/**
 * The stored `user_baseline` percentile columns a `baseline_offset` target
 * may compare against. Omitted means `p50` — the behaviour before the field
 * existed, so a rule written without it compiles to the same SQL.
 */
export const BASELINE_PERCENTILES = ['p05', 'p10', 'p50', 'p90', 'p95'] as const
export type BaselinePercentile = (typeof BASELINE_PERCENTILES)[number]

const TargetBaselineOffset = z.object({
  type: z.literal('baseline_offset'),
  windowDays: z.number().int().positive(),
  /** Absolute units of the metric — the unit the metric is stored in. */
  offset: z.number().positive(),
  direction: z.enum(['below', 'above']),
  /** KVStore key overriding `offset` at eval time. Registry-validated. */
  offsetKey: z.string().min(1).optional(),
  /**
   * Which stored percentile is "usual": `p90` compares against the top of the
   * user's range rather than its middle. Default `p50`. The column name comes
   * from this enum and is inlined; it is never user input.
   */
  percentile: z.enum(BASELINE_PERCENTILES).optional(),
})

/**
 * `phase_band` — outside the user's own stored band, either side.
 *
 * (The name is historical: the target compares each reading against any
 * per-user band of two stored rails, whatever produced them.)
 *
 * The band is two stored rails, `${band}_lo` and `${band}_hi` in
 * `user_baseline` (their `p50`), the same rows an app's screen can draw.
 * While either rail is missing the DEFAULT rails apply (`defaultLo` /
 * `defaultHi`), keeping the rule running on stated defaults rather than
 * going quiet until the user's band is learned. Both stored rails or
 * neither — half a band is not a band.
 *
 * `scaleKey` names a KVStore setting holding a NAMED sensitivity, and
 * `scales` maps each name to a half-width multiplier applied about the band's
 * midpoint, so a user who picked a narrower sensitivity is alerted against
 * the same narrowed band the app shows them.
 *
 * Reading-cadence `consecutive` only: the band is stable for the window, and
 * each reading is compared to it — the same per-sample shape as
 * `user_setting`, not a per-window baseline mean.
 */
const TargetPhaseBand = z.object({
  type: z.literal('phase_band'),
  /** `user_baseline.metric` prefix; rails are `${band}_lo` / `${band}_hi`. */
  band: z.string().min(1),
  windowDays: z.number().int().positive(),
  /**
   * Default rails to compare against while the user's own are missing.
   *
   * OPTIONAL, and omitting them is the honest default: with no rails stored
   * and no fallback the rule emits NO violation, which is what "still
   * learning" means everywhere else in the product (principle 27).
   *
   * Supplying them keeps the rule running on a default range before the
   * user has one. That is a real choice with a real cost — a narrow range
   * fires for every user whose normal sits outside it, for the whole
   * learning period — so it is stated per rule rather than assumed. A rule
   * on a fixed default band once alerted for weeks on users whose own band
   * sat outside it.
   *
   * Both or neither — enforced by `validatePhaseBand`, not here: a
   * `.refine()` makes this a ZodEffects, which `z.discriminatedUnion`
   * cannot hold.
   */
  defaultLo: z.number().optional(),
  defaultHi: z.number().optional(),
  scaleKey: z.string().min(1).optional(),
  scales: z.record(z.string(), z.number().positive()).optional(),
  /** The `scales` entry used when the setting is unset or unknown. */
  defaultScale: z.string().optional(),
})

export const TargetSchema = z.discriminatedUnion('type', [
  TargetAbsolute,
  TargetBaselinePercent,
  TargetBaselineStddev,
  TargetRange,
  TargetUserSetting,
  TargetBaselineOffset,
  TargetPhaseBand,
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
  metric: z.string().superRefine(oneOf(() => exposedMetricIds())),
  window: z.enum(WINDOWS),
  aggregation: z.enum(AGGREGATIONS).default('avg'),
  compare: z.enum(COMPARES),
  /** Restrict samples to a physiological context. Default `any`. */
  context: z.string().superRefine(oneOf(() => ruleContextNames())).default('any'),
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
  /**
   * Minimum distinct LOCAL days with data in the window before the rule may
   * fire. A window aggregate over a source that reported on one day of
   * seven measures the gaps, not the user: a weekly total rule summed a
   * week of readings and fired on a device paired that morning. Days are the user's local
   * days, so the evaluator binds `$tz`. Window aggregates only (validator).
   */
  minDays: z.number().int().min(1).optional(),
  target: TargetSchema,
  severity: z.enum(SEVERITIES),
  throttle: ThrottleSchema,
  rawSql: z.string().optional(),
  rawSqlParams: z.array(z.string()).optional(),
  /**
   * Per-user setting values a `rawSql` body binds, keyed by placeholder name:
   * `{ floor: { key, defaultValue } }` binds `$floor` to the user's stored
   * value of `key` (falling back to `defaultValue`), read the same way a
   * `user_setting` target's threshold is. Each key must be rule-readable in
   * the packs' settings registry (validator). Bound, never interpolated.
   *
   * A `rawSql` body may also read `$tz` (the user's IANA zone): the
   * evaluator binds it from `userTimezoneProvider`, and skips the rule for a
   * user with no zone, exactly as it does for day cadence.
   */
  rawSqlSettings: z.record(
    z.string().regex(/^[A-Z_]\w*$/i),
    z.object({ key: z.string().min(1), defaultValue: z.number() }),
  ).optional(),
  /**
   * Required-true when `rawSql` references `collected_only` columns
   * (BP, vascular aging). Validator enforces.
   */
  exposureOverride: z.boolean().optional(),
})

export type Rule = z.infer<typeof RuleSchema>
