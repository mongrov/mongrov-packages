/**
 * Zod schema for structured threshold rules (spec §Rule schema).
 *
 * The `metric` enum is generated at module load from the frozen
 * `METRIC_METADATA` registry — only metrics with `exposure: 'full'` are
 * accepted. Rules referencing `collected_only` metrics can still ship
 * via `rawSql` + `exposureOverride: true` (see validator.ts).
 */

import { z } from 'zod'
import { getExposedMetricIds, type MetricId } from '../core/metric_metadata'

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
  'equals',
  'not_equals',
  'between',
] as const
export type Compare = (typeof COMPARES)[number]

export const SEVERITIES = ['info', 'warn', 'critical'] as const
export type Severity = (typeof SEVERITIES)[number]

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

export const TargetSchema = z.discriminatedUnion('type', [
  TargetAbsolute,
  TargetBaselinePercent,
  TargetBaselineStddev,
  TargetRange,
])
export type Target = z.infer<typeof TargetSchema>

export const ThrottleSchema = z
  .object({
    minGapMinutes: z.number().nonnegative().default(60),
    maxPerDay: z.number().int().positive().default(3),
  })
  .default({})

export type Throttle = z.infer<typeof ThrottleSchema>

export const RuleSchema = z.object({
  id: z.string().min(1),
  brand: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  metric: z.enum(exposedMetricIds),
  window: z.enum(WINDOWS),
  aggregation: z.enum(AGGREGATIONS).default('avg'),
  compare: z.enum(COMPARES),
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
