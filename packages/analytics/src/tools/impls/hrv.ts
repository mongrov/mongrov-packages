import type { ToolImpl, ToolResult } from '../types'
import { z } from 'zod'
import { assertNoBanTerms, deltaPct, formatBytes } from '../formatters'

export const getHRVInputSchema = z.object({
  userId: z.string(),
  days: z.number().int().min(1).max(90),
})

export type GetHRVInput = z.infer<typeof getHRVInputSchema>

interface Row {
  day: string
  avg_hrv: number
}

export const getHRV: ToolImpl<GetHRVInput> = async (input, ctx) => {
  const rows = await ctx.analytics.execute<Row>(
    `SELECT date_trunc('day', ts)::VARCHAR AS day, AVG(hrv_ms)::DOUBLE AS avg_hrv
     FROM v_hrv
     WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
       AND ts >= now() - INTERVAL (CAST($days AS BIGINT)) DAY
       AND hrv_ms IS NOT NULL
     GROUP BY 1 ORDER BY 1`,
    {
      userId: input.userId,
      brand: ctx.brand,
      familyId: ctx.familyId,
      days: input.days,
    },
  )

  if (rows.length === 0) {
    return finalize('No HRV data for the requested window.', 0)
  }

  const values = rows.map(r => r.avg_hrv)
  const baseline = values.reduce((a, v) => a + v, 0) / values.length
  const latest = values[values.length - 1]
  const daily = rows
    .map(r => `  ${r.day}: ${r.avg_hrv.toFixed(1)}ms`)
    .join('\n')

  const text
    = `HRV, last ${input.days} days:\n${daily}\n`
      + `  ${input.days}-day avg: ${baseline.toFixed(1)}ms `
      + `(latest ${latest.toFixed(1)}ms, ${deltaPct(latest, baseline)} vs avg)`

  return finalize(text, rows.length)
}

function finalize(text: string, rowCount: number): ToolResult {
  // principle 37 — every formatter's return path is guarded, not
  // just the SpO2 one. Tool text lands in an LLM's context, and the
  // model repeats whatever register it finds there.
  assertNoBanTerms(text, 'getHRV')
  return { text, rowCount, bytes: formatBytes(text) }
}
