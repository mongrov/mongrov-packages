import { z } from 'zod'
import { formatBytes } from '../formatters'
import type { ToolImpl, ToolResult } from '../types'

export const getSleepSummaryInputSchema = z.object({
  userId: z.string(),
  days: z.number().int().min(1).max(90),
})

export type GetSleepSummaryInput = z.infer<typeof getSleepSummaryInputSchema>

interface Row {
  night_of: string
  total_minutes: number
  deep_minutes: number | null
  rem_minutes: number | null
  light_minutes: number | null
}

export const getSleepSummary: ToolImpl<GetSleepSummaryInput> = async (
  input,
  ctx,
) => {
  const rows = await ctx.analytics.execute<Row>(
    `SELECT night_of::VARCHAR AS night_of,
            SUM(total_minutes)::INTEGER AS total_minutes,
            SUM(deep_minutes)::INTEGER AS deep_minutes,
            SUM(rem_minutes)::INTEGER AS rem_minutes,
            SUM(light_minutes)::INTEGER AS light_minutes
     FROM sleep_session
     WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
       AND ts_start >= now() - INTERVAL ($days) DAY
     GROUP BY night_of ORDER BY night_of`,
    {
      userId: input.userId,
      brand: ctx.brand,
      familyId: ctx.familyId,
      days: input.days,
    },
  )

  if (rows.length === 0) {
    return finalize('No sleep sessions for the requested window.', 0)
  }

  const totalMean
    = rows.reduce((a, r) => a + r.total_minutes, 0) / rows.length
  const perNight = rows
    .map((r) => {
      const parts: string[] = [`${r.total_minutes}m total`]
      if (r.deep_minutes != null) parts.push(`${r.deep_minutes}m deep`)
      if (r.rem_minutes != null) parts.push(`${r.rem_minutes}m REM`)
      return `  ${r.night_of}: ${parts.join(', ')}`
    })
    .join('\n')

  const text
    = `Sleep, last ${input.days} days:\n${perNight}\n`
    + `  ${rows.length}-night avg total: ${totalMean.toFixed(0)}m`

  return finalize(text, rows.length)
}

function finalize(text: string, rowCount: number): ToolResult {
  return { text, rowCount, bytes: formatBytes(text) }
}
