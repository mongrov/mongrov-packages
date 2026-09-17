import type { ToolContext } from './types'

/**
 * A stored naive-UTC timestamp's LOCAL calendar day, as `YYYY-MM-DD`.
 *
 * Every tool used to bucket by `date_trunc('day', ts)` — a UTC day. For a user
 * in Asia/Kolkata that day runs 05:30 to 05:30, so the model's "Tuesday" mixed
 * Tuesday evening with Wednesday morning and disagreed with every screen,
 * which buckets by the user's own day. Storage is UTC; the zone converts
 * here, in the query, and nowhere else.
 *
 * Two `timezone()` calls because the column is naive: label it UTC, then
 * convert to `$tz` (see the `now()` vs column note in core). `::DATE` so the
 * label is a date, not "2026-07-08 00:00:00", which is what the old
 * `date_trunc(...)::VARCHAR` actually rendered into the model's context.
 */
export function localDay(column = 'ts'): string {
  return `CAST(date_trunc('day', timezone(CAST($tz AS VARCHAR), timezone('UTC', ${column}))) AS DATE)::VARCHAR`
}

/**
 * `{ tz }` when the SQL binds it, `{}` otherwise — DuckDB rejects a named
 * parameter the statement does not declare, and several tools share one
 * parameter object across metric-specific statements.
 */
export function tzParam(ctx: ToolContext, sql: string): { tz?: string } {
  return sql.includes('$tz') ? { tz: ctx.timezone ?? 'UTC' } : {}
}
