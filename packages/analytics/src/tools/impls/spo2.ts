/**
 * `getSpO2` (Sprint 5 §5 / T-30 / T-31).
 *
 * Nightly SpO₂ summary for the conversational surface. Two things make it
 * different from the other tools:
 *
 * 1. It is **sleep-scoped**. "How was my oxygen last night?" means during
 *    sleep, so the query INNER JOINs `v_sleep_session` rather than
 *    averaging around the clock — daytime readings would wash out exactly
 *    the dips the question is about.
 * 2. Its formatter is the reference implementation for principle 37. The
 *    data has a field literally counting low moments, and the obvious
 *    clinical word for it is banned. See `formatters/spo2.ts`.
 */

import { z } from 'zod'
import { formatSpO2 } from '../formatters/spo2'
import { formatBytes } from '../formatters'
import type { ToolImpl, ToolResult } from '../types'

export const getSpO2InputSchema = z.object({
  userId: z.string(),
  days: z.number().int().min(1).max(90),
})

export type GetSpO2Input = z.infer<typeof getSpO2InputSchema>

/** One night's aggregate, as returned by the query. */
export interface SpO2NightRow {
  night_of: string
  avg_spo2: number
  min_spo2: number
  low_moment_count: number
}

/** Reference range from `user_baseline`, when mature. */
export interface SpO2BaselineRow {
  p05: number
  p10: number
  p50: number
  computed_at: string
}

/**
 * Threshold below which a reading counts as a "low moment".
 *
 * Fixed at 90 rather than read from `user:spo2SafeLevel`: this is a
 * descriptive summary, not the user's alert. Tying it to their alert
 * threshold would make the same night read differently after they moved a
 * slider, which is confusing in a narrative context.
 */
export const LOW_MOMENT_THRESHOLD = 90

export const getSpO2: ToolImpl<GetSpO2Input> = async (input, ctx) => {
  const params = {
    userId: input.userId,
    brand: ctx.brand,
    familyId: ctx.familyId,
    days: input.days,
  }

  const nights = await ctx.analytics.execute<SpO2NightRow>(
    `SELECT s.night_of::VARCHAR AS night_of,
            AVG(m.spo2)::DOUBLE AS avg_spo2,
            MIN(m.spo2)::DOUBLE AS min_spo2,
            COUNT(*) FILTER (WHERE m.spo2 < ${LOW_MOMENT_THRESHOLD})::INTEGER AS low_moment_count
     FROM v_spo2 m
     INNER JOIN v_sleep_session s
        ON s.user_id = m.user_id
       AND s.brand = m.brand
       AND s.family_id = m.family_id
       AND m.ts BETWEEN s.ts_start AND s.ts_end
     WHERE m.user_id = $userId AND m.brand = $brand AND m.family_id = $familyId
       AND m.ts >= now() - INTERVAL ($days) DAY
     GROUP BY s.night_of
     ORDER BY s.night_of`,
    params,
  )

  // Reference range comes from the shared baseline table so the narrative
  // and the chart's "usual range" band cannot disagree.
  const baselineRows = await ctx.analytics.execute<SpO2BaselineRow>(
    `SELECT p05, p10, p50, computed_at::VARCHAR AS computed_at
     FROM user_baseline
     WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
       AND metric = 'spo2' AND window_days = 30
     LIMIT 1`,
    { userId: input.userId, brand: ctx.brand, familyId: ctx.familyId },
  )

  const text = formatSpO2(nights, baselineRows[0] ?? null, input.days)
  return finalize(text, nights.length)
}

function finalize(text: string, rowCount: number): ToolResult {
  return { text, rowCount, bytes: formatBytes(text) }
}
