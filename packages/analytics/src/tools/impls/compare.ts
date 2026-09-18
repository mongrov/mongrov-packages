import type { ToolImpl, ToolResult } from '../types'
import { z } from 'zod'
import { assertNoBanTerms, deltaPct, formatBytes } from '../formatters'
import { localDay, tzParam } from '../local-day'

export const compareTrendInputSchema = z.object({
  userId: z.string(),
  metric: z.enum(['hrv_ms', 'sleep_total_minutes', 'activity_steps']),
  currentWindowDays: z.number().int().min(1).max(30),
  priorWindowDays: z.number().int().min(1).max(30),
})

export type CompareTrendInput = z.infer<typeof compareTrendInputSchema>

interface Row {
  value: number
}

interface MetricSpec {
  sql: (windowDays: number, offsetDays: number) => string
  unit: string
  label: string
}

const METRIC_SPECS: Record<CompareTrendInput['metric'], MetricSpec> = {
  hrv_ms: {
    sql: (windowDays, offsetDays) =>
      `SELECT AVG(hrv_ms)::DOUBLE AS value
       FROM v_hrv_clean
       WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
         AND hrv_ms IS NOT NULL
         AND ts >= now() - INTERVAL (${windowDays + offsetDays}) DAY
         AND ts <  now() - INTERVAL (${offsetDays}) DAY`,
    unit: 'ms',
    label: 'HRV',
  },
  sleep_total_minutes: {
    sql: (windowDays, offsetDays) =>
      // Per NIGHT, then averaged. A night can be stored as two sessions (a
      // 20-30 minute gap splits the primary block), so AVG over sessions
      // reported a 7h night as a 3h and a 4h one. detectAnomaly already sums
      // per night_of; this matches it.
      `SELECT AVG(nightly)::DOUBLE AS value FROM (
         SELECT night_of, SUM(total_minutes) AS nightly
         FROM v_sleep_session
         WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
           AND ts_start >= now() - INTERVAL (${windowDays + offsetDays}) DAY
           AND ts_start <  now() - INTERVAL (${offsetDays}) DAY
         GROUP BY night_of
       )`,
    unit: 'min',
    label: 'sleep total',
  },
  activity_steps: {
    sql: (windowDays, offsetDays) =>
      `SELECT AVG(daily_steps)::DOUBLE AS value FROM (
         SELECT ${localDay()} AS day, SUM(steps) AS daily_steps
         FROM v_activity
         WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
           AND ts >= now() - INTERVAL (${windowDays + offsetDays}) DAY
           AND ts <  now() - INTERVAL (${offsetDays}) DAY
         GROUP BY 1
       )`,
    unit: 'steps/day',
    label: 'activity',
  },
}

export const compareTrend: ToolImpl<CompareTrendInput> = async (
  input,
  ctx,
) => {
  const spec = METRIC_SPECS[input.metric]
  const params = {
    userId: input.userId,
    brand: ctx.brand,
    familyId: ctx.familyId,
  }

  const currentSql = spec.sql(input.currentWindowDays, 0)
  const priorSql = spec.sql(input.priorWindowDays, input.currentWindowDays)
  const currentRows = await ctx.analytics.execute<Row>(currentSql, { ...params, ...tzParam(ctx, currentSql) })
  const priorRows = await ctx.analytics.execute<Row>(priorSql, { ...params, ...tzParam(ctx, priorSql) })

  const current = currentRows[0]?.value ?? null
  const prior = priorRows[0]?.value ?? null

  if (current == null && prior == null) {
    return finalize(
      `Insufficient ${spec.label} data to compare the requested windows.`,
      0,
    )
  }

  const text
    = `${spec.label} trend (${input.metric}):\n`
      + `  current ${input.currentWindowDays}d: ${fmt(current)}${spec.unit}\n`
      + `  prior ${input.priorWindowDays}d:   ${fmt(prior)}${spec.unit}\n`
      + `  delta: ${
        current != null && prior != null ? deltaPct(current, prior) : 'n/a'
      }`

  return finalize(text, (current == null ? 0 : 1) + (prior == null ? 0 : 1))
}

function fmt(v: number | null): string {
  return v == null ? 'n/a' : v.toFixed(1)
}

function finalize(text: string, rowCount: number): ToolResult {
  // principle 37 — every formatter's return path is guarded, not
  // just the SpO2 one. Tool text lands in an LLM's context, and the
  // model repeats whatever register it finds there.
  assertNoBanTerms(text, 'compareTrend')
  return { text, rowCount, bytes: formatBytes(text) }
}
