import { z } from 'zod'
import { assertNoBanTerms, formatBytes, popStddev } from '../formatters'
import type { ToolImpl, ToolResult } from '../types'

export const detectAnomalyInputSchema = z.object({
  userId: z.string(),
  metric: z.enum(['hrv_ms', 'sleep_total_minutes', 'activity_steps']),
  lookbackDays: z.number().int().min(7).max(90),
  stddevThreshold: z.number().min(1).max(4).default(2),
})

export type DetectAnomalyInput = z.infer<typeof detectAnomalyInputSchema>

interface Row {
  day: string
  value: number
}

interface MetricSpec {
  sql: (lookbackDays: number) => string
  unit: string
  label: string
}

const METRIC_SPECS: Record<DetectAnomalyInput['metric'], MetricSpec> = {
  hrv_ms: {
    sql: lookbackDays =>
      `SELECT date_trunc('day', ts)::VARCHAR AS day, AVG(hrv_ms)::DOUBLE AS value
       FROM v_hrv
       WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
         AND hrv_ms IS NOT NULL
         AND ts >= now() - INTERVAL (${lookbackDays}) DAY
       GROUP BY 1 ORDER BY 1`,
    unit: 'ms',
    label: 'HRV',
  },
  sleep_total_minutes: {
    sql: lookbackDays =>
      `SELECT night_of::VARCHAR AS day, SUM(total_minutes)::DOUBLE AS value
       FROM v_sleep_session
       WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
         AND ts_start >= now() - INTERVAL (${lookbackDays}) DAY
       GROUP BY night_of ORDER BY night_of`,
    unit: 'min',
    label: 'sleep total',
  },
  activity_steps: {
    sql: lookbackDays =>
      `SELECT date_trunc('day', ts)::VARCHAR AS day, SUM(steps)::DOUBLE AS value
       FROM v_activity
       WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
         AND ts >= now() - INTERVAL (${lookbackDays}) DAY
       GROUP BY 1 ORDER BY 1`,
    unit: 'steps',
    label: 'activity',
  },
}

export const detectAnomaly: ToolImpl<DetectAnomalyInput> = async (
  input,
  ctx,
) => {
  const spec = METRIC_SPECS[input.metric]
  const rows = await ctx.analytics.execute<Row>(spec.sql(input.lookbackDays), {
    userId: input.userId,
    brand: ctx.brand,
    familyId: ctx.familyId,
  })

  if (rows.length === 0) {
    return finalize(
      `No ${spec.label} data for the last ${input.lookbackDays} days.`,
      0,
    )
  }

  const values = rows.map(r => r.value)
  const mean = values.reduce((a, v) => a + v, 0) / values.length
  const stddev = popStddev(values)
  const gate = input.stddevThreshold * stddev

  const outliers = rows.filter(r => Math.abs(r.value - mean) > gate)

  const outlierText
    = outliers.length === 0
      ? '  No outliers detected.'
      : outliers
          .map(
            r =>
              `  ${r.day}: ${r.value.toFixed(1)}${spec.unit} `
              + `(${(r.value - mean).toFixed(1)}${spec.unit} from mean)`,
          )
          .join('\n')

  const text
    = `${spec.label} anomalies (last ${input.lookbackDays}d, `
    + `threshold ${input.stddevThreshold}σ):\n`
    + `  baseline: mean ${mean.toFixed(1)}${spec.unit}, `
    + `stddev ${stddev.toFixed(1)}${spec.unit}\n`
    + `${outlierText}`

  return finalize(text, outliers.length)
}

function finalize(text: string, rowCount: number): ToolResult {
  // principle 37 — every formatter's return path is guarded, not
  // just the SpO2 one. Tool text lands in an LLM's context, and the
  // model repeats whatever register it finds there.
  assertNoBanTerms(text, 'detectAnomaly')
  return { text, rowCount, bytes: formatBytes(text) }
}
