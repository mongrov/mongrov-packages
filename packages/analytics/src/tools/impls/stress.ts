import type { ToolImpl, ToolResult } from '../types'
import { z } from 'zod'

import { assertNoBanTerms, formatBytes } from '../formatters'
import { localDay, tzParam } from '../local-day'

export const getStressInputSchema = z.object({
  userId: z.string(),
  days: z.number().int().min(1).max(90),
})

export type GetStressInput = z.infer<typeof getStressInputSchema>

interface DayRow {
  day: string
  avg_stress: number
  hi_stress: number
}

interface BaselineRow {
  p10: number
  p50: number
  p90: number
}

/**
 * Daily stress score against the user's own usual range (zivaone_app#24).
 *
 * Reads `v_hrv_clean`, whose `stress` is NULL for a reading that is not
 * stress-clean (off-wrist, warm-up, moving) — so an active hour does not read
 * as a tense one, the same masking the rules and the Stress screen apply.
 * Compares to the user's own band; never labels a day tense on its own
 * authority.
 */
export const getStress: ToolImpl<GetStressInput> = async (input, ctx) => {
  const sql = `SELECT ${localDay()} AS day,
            AVG(stress)::DOUBLE AS avg_stress,
            MAX(stress)::DOUBLE AS hi_stress
     FROM v_hrv_clean
     WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
       AND ts >= now() - INTERVAL (CAST($days AS BIGINT)) DAY
       AND stress IS NOT NULL
     GROUP BY 1 ORDER BY 1`
  const rows = await ctx.analytics.execute<DayRow>(sql, {
    userId: input.userId,
    brand: ctx.brand,
    familyId: ctx.familyId,
    days: input.days,
    ...tzParam(ctx, sql),
  })

  if (rows.length === 0)
    return finalize('No stress data for the requested window.', 0)

  const baseline = await readBaseline(ctx, input.userId)
  const daily = rows
    .map(r => `  ${r.day}: avg ${Math.round(r.avg_stress)} (high ${Math.round(r.hi_stress)})`)
    .join('\n')
  const usual = baseline === null
    ? '  usual daily average: not established yet'
    : `  usual daily average: ${Math.round(baseline.p10)}–${Math.round(baseline.p90)} (typical ${Math.round(baseline.p50)})`

  return finalize(`Stress score (0–100), last ${input.days} days:\n${daily}\n${usual}`, rows.length)
}

async function readBaseline(
  ctx: Parameters<ToolImpl<GetStressInput>>[1],
  userId: string,
): Promise<BaselineRow | null> {
  try {
    const rows = await ctx.analytics.execute<BaselineRow>(
      `SELECT p10::DOUBLE AS p10, p50::DOUBLE AS p50, p90::DOUBLE AS p90
       FROM user_baseline
       WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
         AND metric = 'stress' AND window_days = 30`,
      { userId, brand: ctx.brand, familyId: ctx.familyId },
    )
    return rows[0] ?? null
  }
  catch {
    return null
  }
}

function finalize(text: string, rowCount: number): ToolResult {
  assertNoBanTerms(text, 'getStress')
  return { text, rowCount, bytes: formatBytes(text) }
}
