/**
 * Bounded reads of the quality relations from inside the package
 * (mongrov-packages#44).
 *
 * The `_q` / `_clean` views and `v_motion` are window functions over each
 * tenant's whole history, so a query for one day pays for every reading ever
 * taken: ~200 ms a query at 180 days, against 8-50 ms through the bounded
 * macros (`v_x_clean_between(lo, hi)`, see `reading-quality.ts`). Rules,
 * the HR phase bands and the AI tools all read a known window back from now,
 * so they can name the macro instead.
 *
 * ## Why swapping the relation cannot change an answer
 *
 * Each macro returns exactly its view's rows with `lo <= ts < hi`
 * (`bounded-quality-equivalence.test.ts`). A reader keeps its own WHERE
 * clause unchanged, so the bounds only need to be a SUPERSET of the rows that
 * WHERE already selects. Every bound here is therefore generous by a spare
 * day: the session zone is pinned to UTC (`bootstrapExtensions`), but a naive
 * `ts` compared with `NOW()` would shift by up to 14 hours if that pin were
 * ever lost, and a day covers it at almost no cost.
 *
 * ## The argument shape is the app's
 *
 * `timezone('UTC', now()) -/+ (INTERVAL 1 <unit>) * <BIGINT expr>` — exactly
 * what zivaone_app's `bounded()` helper already sends through the device's
 * DuckDB build (principle 68). A bound parameter appears only as
 * `CAST($p AS BIGINT)`, never inside a scalar subquery: a subquery cannot
 * fold to a constant, so no slice filter would prune (the app measured 300x
 * slower for identical rows).
 *
 * ## Where exactness ends
 *
 * A reader with no upper time filter would, through the view, also see a
 * reading dated more than `FORWARD_DAYS` in the future. Only a ring clock a
 * month fast produces one; the app's `bounded()` draws the same line.
 */

import type { AnalyticsEngine } from './types'

/** How far past now an open-ended window reaches. Same as the app's `bounded()`. */
export const FORWARD_DAYS = 32

/**
 * Run-time failures of bounded statements, in one attach, after which the
 * engine stops offering them (`AnalyticsEngine.reportBoundedReadFailure`).
 */
export const BOUNDED_FAILURE_LIMIT = 3

/** Spare whole days on every lookback; see the module doc. */
export const SPARE_DAYS = 1

const NOW_UTC = `timezone('UTC', now())`

/** Bounds as INTERVAL expressions relative to now: `lo = now - back`, `hi = now + ahead`. */
export interface NowWindow {
  back: string
  ahead?: string
}

/** `INTERVAL` of `n` whole hours, in the device-proven `unit * BIGINT` shape. */
export function hoursInterval(n: number): string {
  return `(INTERVAL 1 HOUR) * CAST(${Math.ceil(n)} AS BIGINT)`
}

/** `INTERVAL` of `expr` whole days, where `expr` is a SQL BIGINT expression. */
export function daysInterval(expr: string | number): string {
  return `(INTERVAL 1 DAY) * ${typeof expr === 'number' ? `CAST(${expr} AS BIGINT)` : expr}`
}

/** `<view>_between(now - back, now + ahead)`. */
export function boundedRelation(view: string, window: NowWindow): string {
  const ahead = window.ahead ?? `INTERVAL ${FORWARD_DAYS} DAY`
  return `${view}_between(${NOW_UTC} - ${window.back}, ${NOW_UTC} + ${ahead})`
}

/** Picks a relation: the view itself, or its bounded macro over `window`. */
export type RelationFor = (view: string, window: NowWindow) => string

const VIEW_FORM: RelationFor = view => view

/**
 * Run a read in its bounded form, falling back to the view form if that
 * throws (mongrov-packages#44).
 *
 * `boundedReads` says every macro was CREATED at attach. That is not proof
 * a statement naming one runs on this device's build — principle 68 records
 * three shapes that passed desktop and failed only natively. So a failure of
 * the bounded form is never the reader's failure:
 *
 *   1. `onBoundedFailed` is told (callers log a distinct `*.bounded_failed`).
 *   2. The engine is told (`reportBoundedReadFailure`), which turns
 *      `boundedReads` off for the rest of the attach after a few failures —
 *      a shape that fails once will fail every pass.
 *   3. One throwaway `SELECT 1` absorbs the aborted transaction a failed
 *      prepare can leave on the react-native-duckdb build (zivaone_app#195),
 *      so the retry is not the statement that pays for it. On a healthy
 *      connection it simply succeeds.
 *   4. The view form runs, and ITS failure is the caller's, as before.
 *
 * Without the capability the view form runs directly: an engine that does
 * not report it may not have the macros at all.
 */
export async function executeBounded<T>(
  analytics: Pick<AnalyticsEngine, 'boundedReads' | 'execute' | 'reportBoundedReadFailure'>,
  forms: { bounded?: string, view: string },
  params: Record<string, unknown>,
  onBoundedFailed?: (cause: unknown) => void,
): Promise<T[]> {
  if (analytics.boundedReads === true && forms.bounded !== undefined) {
    try {
      return await analytics.execute<T>(forms.bounded, params)
    }
    catch (cause) {
      onBoundedFailed?.(cause)
      analytics.reportBoundedReadFailure?.()
      try {
        await analytics.execute('SELECT 1')
      }
      catch {
        // expected when the failure poisoned the connection: this absorbs it.
      }
    }
  }
  return analytics.execute<T>(forms.view, params)
}

/**
 * `executeBounded` for a query that names its relations through `build`:
 * called once with the bounded macros and once with the plain views, so the
 * two forms differ ONLY in the relations.
 */
export function executeBoundedRead<T>(
  analytics: Pick<AnalyticsEngine, 'boundedReads' | 'execute' | 'reportBoundedReadFailure'>,
  build: (relation: RelationFor) => string,
  params: (sql: string) => Record<string, unknown>,
  onBoundedFailed?: (cause: unknown) => void,
): Promise<T[]> {
  const view = build(VIEW_FORM)
  return executeBounded<T>(
    analytics,
    { bounded: analytics.boundedReads === true ? build(boundedRelation) : undefined, view },
    params(view),
    onBoundedFailed,
  )
}
