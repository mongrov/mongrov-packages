import { z } from 'zod'
import { formatBytes } from '../formatters'
import type { ToolImpl, ToolResult } from '../types'

export const getInsightsInputSchema = z.object({
  userId: z.string(),
  days: z.number().int().min(1).max(30).default(7),
  severity: z.enum(['info', 'warn', 'critical']).optional(),
})

export type GetInsightsInput = z.infer<typeof getInsightsInputSchema>

interface Row {
  id: string
  ts: string
  severity: string
  title: string
  body: string | null
}

export const getInsights: ToolImpl<GetInsightsInput> = async (input, ctx) => {
  const params: Record<string, unknown> = {
    userId: input.userId,
    brand: ctx.brand,
    familyId: ctx.familyId,
    days: input.days,
  }
  let severityClause = ''
  if (input.severity) {
    severityClause = ' AND severity = $severity'
    params.severity = input.severity
  }

  const rows = await ctx.analytics.execute<Row>(
    `SELECT id, ts::VARCHAR AS ts, severity, title, body
     FROM insight
     WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
       AND ts >= now() - INTERVAL ($days) DAY${severityClause}
     ORDER BY ts DESC`,
    params,
  )

  if (rows.length === 0) {
    const scope = input.severity ? ` (${input.severity})` : ''
    return finalize(
      `No insights${scope} in the last ${input.days} days.`,
      0,
    )
  }

  const bullets = rows
    .map((r) => {
      const body = r.body ? ` — ${r.body}` : ''
      return `  [${r.severity}] ${r.ts}: ${r.title}${body}`
    })
    .join('\n')

  const text = `Insights, last ${input.days} days:\n${bullets}`
  return finalize(text, rows.length)
}

function finalize(text: string, rowCount: number): ToolResult {
  return { text, rowCount, bytes: formatBytes(text) }
}
