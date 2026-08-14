import type { ToolImpl, ToolResult } from '../types'
import { z } from 'zod'

import { precisionFor } from '../../core/metric_metadata'
import { assertNoBanTerms, formatBytes } from '../formatters'

export const getTemperatureInputSchema = z.object({
  userId: z.string(),
  days: z.number().int().min(1).max(90),
})

export type GetTemperatureInput = z.infer<typeof getTemperatureInputSchema>

interface DayRow {
  day: string
  avg_temp: number
  hi_temp: number
  lo_temp: number
}

interface BaselineRow {
  p10: number
  p50: number
  p90: number
}

/**
 * Daily temperature against the user's own usual range (sprint6 §6).
 *
 * Two things this deliberately does not do:
 *
 *   - It never says whether a temperature is high. "Running warm" is a
 *     comparison to the user's own band; a threshold judgement belongs to
 *     the rules engine, which the user configures. A tool that editorialises
 *     teaches the model to do the same.
 *   - It never prints more decimals than the ring measured. Today's hardware
 *     reports whole degrees (`precisionFor('temp_c') === 1`), so rendering
 *     "36.8" off a whole-degree reading would be inventing detail. The
 *     column is DECIMAL(4,1) so a finer device needs no migration — the
 *     formatter follows the device, not the column.
 */
export const getTemperature: ToolImpl<GetTemperatureInput> = async (input, ctx) => {
  const rows = await ctx.analytics.execute<DayRow>(
    `SELECT date_trunc('day', ts)::VARCHAR AS day,
            AVG(temp_c)::DOUBLE AS avg_temp,
            MAX(temp_c)::DOUBLE AS hi_temp,
            MIN(temp_c)::DOUBLE AS lo_temp
     FROM v_temperature
     WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
       AND ts >= now() - INTERVAL (CAST($days AS BIGINT)) DAY
       AND temp_c IS NOT NULL
     GROUP BY 1 ORDER BY 1`,
    {
      userId: input.userId,
      brand: ctx.brand,
      familyId: ctx.familyId,
      days: input.days,
    },
  )

  if (rows.length === 0)
    return finalize('No temperature data for the requested window.', 0)

  const baseline = await readBaseline(ctx, input.userId)
  const decimals = decimalsFor(precisionFor('temp_c'))

  const daily = rows
    .map(r =>
      `  ${r.day}: ${r.avg_temp.toFixed(decimals)}°C `
      + `(low ${r.lo_temp.toFixed(decimals)}, high ${r.hi_temp.toFixed(decimals)})`,
    )
    .join('\n')

  const usual = baseline === null
    ? '  usual range: not established yet'
    : `  usual range: ${baseline.p10.toFixed(decimals)}–${baseline.p90.toFixed(decimals)}°C `
      + `(typical ${baseline.p50.toFixed(decimals)})`

  return finalize(
    `Temperature in °C, last ${input.days} days:\n${daily}\n${usual}`,
    rows.length,
  )
}

/**
 * The user's own band, or null before the 20-day gate passes.
 *
 * A failure here degrades to "not established yet" rather than failing the
 * whole call: the daily numbers are useful without the comparison, and a
 * tool that throws because a secondary read failed gives the model nothing.
 */
async function readBaseline(
  ctx: Parameters<ToolImpl<GetTemperatureInput>>[1],
  userId: string,
): Promise<BaselineRow | null> {
  try {
    const rows = await ctx.analytics.execute<BaselineRow>(
      `SELECT p10::DOUBLE AS p10, p50::DOUBLE AS p50, p90::DOUBLE AS p90
       FROM user_baseline
       WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
         AND metric = 'temp_c' AND window_days = 30`,
      { userId, brand: ctx.brand, familyId: ctx.familyId },
    )
    return rows[0] ?? null
  }
  catch {
    return null
  }
}

/** Decimal places justified by what the device reports. */
function decimalsFor(precision: number | undefined): number {
  if (precision === undefined || precision >= 1)
    return 0
  return Math.min(2, Math.ceil(-Math.log10(precision)))
}

function finalize(text: string, rowCount: number): ToolResult {
  // principle 37 — guarded on the return path, like every other formatter.
  // The temperature vocabulary is the point: sprint6 §6 added `febrile` and
  // `pyrexia` because "running warm" is the register Ziva speaks.
  assertNoBanTerms(text, 'getTemperature')
  return { text, rowCount, bytes: formatBytes(text) }
}
