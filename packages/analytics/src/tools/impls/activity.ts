import type { ToolImpl, ToolResult } from '../types'
import { z } from 'zod'
import { assertNoBanTerms, formatBytes } from '../formatters'

export const getActivityTotalInputSchema = z.object({
  userId: z.string(),
  days: z.number().int().min(1).max(90),
})

export type GetActivityTotalInput = z.infer<
  typeof getActivityTotalInputSchema
>

interface StepsRow {
  day: string
  steps: number
}

interface BucketRow {
  day: string
  calories: number | null
  distance_km: number | null
}

export const getActivityTotal: ToolImpl<GetActivityTotalInput> = async (
  input,
  ctx,
) => {
  const params = {
    userId: input.userId,
    brand: ctx.brand,
    familyId: ctx.familyId,
    days: input.days,
  }

  const steps = await ctx.analytics.execute<StepsRow>(
    `SELECT date_trunc('day', ts)::VARCHAR AS day, SUM(steps)::INTEGER AS steps
     FROM v_activity
     WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
       AND ts >= now() - INTERVAL ($days) DAY
     GROUP BY 1 ORDER BY 1`,
    params,
  )

  const buckets = await ctx.analytics.execute<BucketRow>(
    `SELECT date_trunc('day', ts)::VARCHAR AS day,
            SUM(calories)::DOUBLE AS calories,
            SUM(distance_km)::DOUBLE AS distance_km
     FROM v_activity_bucket
     WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
       AND ts >= now() - INTERVAL ($days) DAY
     GROUP BY 1 ORDER BY 1`,
    params,
  )

  if (steps.length === 0 && buckets.length === 0) {
    return finalize('No activity data for the requested window.', 0)
  }

  const bucketByDay = new Map(buckets.map(b => [b.day, b]))
  const days = new Set<string>([
    ...steps.map(s => s.day),
    ...buckets.map(b => b.day),
  ])
  const orderedDays = Array.from(days).sort()

  let totalSteps = 0
  let totalCalories = 0
  let totalDistance = 0
  const perDay: string[] = []
  for (const day of orderedDays) {
    const s = steps.find(r => r.day === day)?.steps ?? 0
    const b = bucketByDay.get(day)
    totalSteps += s
    totalCalories += b?.calories ?? 0
    totalDistance += b?.distance_km ?? 0
    const parts: string[] = [`${s} steps`]
    if (b?.calories != null)
      parts.push(`${b.calories.toFixed(0)} kcal`)
    if (b?.distance_km != null)
      parts.push(`${b.distance_km.toFixed(2)} km`)
    perDay.push(`  ${day}: ${parts.join(', ')}`)
  }

  const text
    = `Activity, last ${input.days} days:\n${perDay.join('\n')}\n`
      + `  Totals: ${totalSteps} steps, `
      + `${totalCalories.toFixed(0)} kcal, `
      + `${totalDistance.toFixed(2)} km`

  return finalize(text, orderedDays.length)
}

function finalize(text: string, rowCount: number): ToolResult {
  // principle 37 — every formatter's return path is guarded, not
  // just the SpO2 one. Tool text lands in an LLM's context, and the
  // model repeats whatever register it finds there.
  assertNoBanTerms(text, 'getActivityTotal')
  return { text, rowCount, bytes: formatBytes(text) }
}
