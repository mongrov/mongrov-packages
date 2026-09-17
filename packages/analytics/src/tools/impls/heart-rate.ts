import type { ToolImpl, ToolResult } from '../types'
import { z } from 'zod'

import { assertNoBanTerms, formatBytes } from '../formatters'
import { localDay, tzParam } from '../local-day'

export const getHeartRateInputSchema = z.object({
  userId: z.string(),
  days: z.number().int().min(1).max(90),
})

export type GetHeartRateInput = z.infer<typeof getHeartRateInputSchema>

interface DayRow {
  day: string
  avg_bpm: number
  lo_bpm: number
  hi_bpm: number
}

interface BaselineRow {
  p10: number
  p50: number
  p90: number
}

/**
 * Daily heart rate against the user's own usual range (zivaone_app#24).
 *
 * Same contract as `getTemperature`: clean readings only (T-25), the user's
 * own days, and a comparison to their own band — never a verdict on whether a
 * number is high. An elevated-HR judgement belongs to the rules engine the
 * user configures (`ziva.hr-flag-level`), not to the words a model repeats.
 */
export const getHeartRate: ToolImpl<GetHeartRateInput> = async (input, ctx) => {
  const sql = `SELECT ${localDay()} AS day,
            AVG(bpm)::DOUBLE AS avg_bpm,
            MIN(bpm)::DOUBLE AS lo_bpm,
            MAX(bpm)::DOUBLE AS hi_bpm
     FROM v_heart_rate_clean
     WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
       AND ts >= now() - INTERVAL (CAST($days AS BIGINT)) DAY
     GROUP BY 1 ORDER BY 1`
  const rows = await ctx.analytics.execute<DayRow>(sql, {
    userId: input.userId,
    brand: ctx.brand,
    familyId: ctx.familyId,
    days: input.days,
    ...tzParam(ctx, sql),
  })

  if (rows.length === 0)
    return finalize('No heart rate data for the requested window.', 0)

  const baseline = await readBaseline(ctx, input.userId)
  const daily = rows
    .map(r => `  ${r.day}: avg ${Math.round(r.avg_bpm)} bpm (low ${Math.round(r.lo_bpm)}, high ${Math.round(r.hi_bpm)})`)
    .join('\n')
  const usual = baseline === null
    ? '  usual daily average: not established yet'
    : `  usual daily average: ${Math.round(baseline.p10)}–${Math.round(baseline.p90)} bpm (typical ${Math.round(baseline.p50)})`

  return finalize(`Heart rate, last ${input.days} days:\n${daily}\n${usual}`, rows.length)
}

/** The user's own band, or null before it exists. A failed read degrades, it does not throw. */
async function readBaseline(
  ctx: Parameters<ToolImpl<GetHeartRateInput>>[1],
  userId: string,
): Promise<BaselineRow | null> {
  try {
    const rows = await ctx.analytics.execute<BaselineRow>(
      `SELECT p10::DOUBLE AS p10, p50::DOUBLE AS p50, p90::DOUBLE AS p90
       FROM user_baseline
       WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
         AND metric = 'hr_bpm' AND window_days = 30`,
      { userId, brand: ctx.brand, familyId: ctx.familyId },
    )
    return rows[0] ?? null
  }
  catch {
    return null
  }
}

function finalize(text: string, rowCount: number): ToolResult {
  assertNoBanTerms(text, 'getHeartRate')
  return { text, rowCount, bytes: formatBytes(text) }
}
