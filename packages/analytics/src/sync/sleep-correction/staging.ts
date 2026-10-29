/**
 * Staging views: the warehouse, re-shaped into v3.1's raw firmware relations.
 *
 * The pipeline's SQL reads sleep(date, quality, start, "unitLength"),
 * heartrate(date, "singleHR") and activity(date, step) with epoch-second
 * dates — the shapes v3.1 was validated on. Rather than rewrite the SQL for
 * the warehouse columns, these TEMP views rename back at the boundary, so the
 * ported queries stay as close to v3.1 as the parity suite proved them.
 *
 * - sleep comes from the LOCAL `sleep_raw` (not viewed: collected-only, and
 *   the nights a batch touches are local). Catalog-qualified, because after
 *   an R2 attach an unqualified name resolves to the remote catalog.
 * - HR and steps come from `v_heart_rate` / `v_activity` (+
 *   `v_activity_bucket`), so a 30-day baseline lookback sees remote history
 *   too.
 * - One user and one device: the correction is per ring.
 *
 * `sleep_raw.quality` must hold the firmware's own codes (1 deep / 2 light /
 * 3 rem / 5 awake). That is true only once the producer sends raw rows
 * (sleep-correction tasks §3); until then these views are exercised by tests.
 *
 * ## Steps are re-aggregated to the firmware's 10-minute buckets
 *
 * v3.1 and the QA study fed Step 5.6's `stepsIn()` the firmware record's
 * `activitydetails.step` — one 10-minute total stamped at the bucket start.
 * The v2 mapper unnests `arraySteps` into 1-minute `activity` rows, and
 * feeding those moved the corrected END on 3/92 study nights by 6–20 min
 * (`__tests__/replay-v1.test.ts`): `stepsIn(a, b)` sums samples with
 * `a < ts <= b`, so where a 10-minute total sits relative to a window edge
 * changes with its placement. Eyal ruled on 2026-10-28 to align v2 to v1, so
 * `activity` here is one row per `activity_bucket` record, `date` = the
 * bucket's start, `step` = the sum of the 1-minute rows inside
 * `[bucket.ts, bucket.ts + 10 min)`. The sum is built with an ASOF join from
 * minute to latest bucket (one probe per minute row) so it stays cheap over
 * a year of history.
 *
 * Residuals against v1, both reported rather than hidden:
 * - `sum(arraySteps)` differs from the record's `step` on ~1.3% of firmware
 *   records (`mapper/activity.ts`); v1 fed `step`, this feeds the sum.
 * - A bucket with no minute rows (empty `arraySteps`) produces no row at
 *   all; v1 would have fed that record's `step` total.
 *
 * `activitySteps: 'minute'` keeps the 1-minute rows as the relation — the
 * deriver's fallback when `activity_bucket` is not subscribed (see
 * `sleep-derive.ts`), never the production default.
 *
 * ## Bounds (zivaone_app#460)
 *
 * Every query filters `date`, which is `epoch(ts)` computed here — an
 * expression, so the filter cannot prune on `ts` (no zone maps locally, no
 * manifest pruning on R2). `StagingBounds` puts a plain `ts >=` bound inside
 * the view instead, where it can. Each bound must be at or below the earliest
 * `date` any query reads from that relation (`stagingBoundsFor` derives them);
 * it is then a prefilter only — every query keeps its own exact `date`
 * filter. The bound sits one second low, because `date` is `epoch(ts)`
 * rounded, so a sub-second `ts` just under it can still round up into range.
 * The activity bound applies to the bucket AND the minute side: a minute row
 * is never before its bucket's start, so the same value is safe for both.
 *
 * Heart rate takes no bound: `detectHrTierSql` reads its whole history.
 */

import type { SleepRelations } from './sql'

import { DEFAULT_RELATIONS, rel } from './sql'

export interface StagingScope {
  brand: string
  familyId: string
  userId: string
  deviceId: string
  /** Local DuckDB catalog holding `sleep_raw`. */
  localCatalog?: string
  /**
   * What the `activity` relation exposes: the firmware's 10-minute bucket
   * totals (`'bucket'`, the default and v3.1's shape) or the 1-minute rows
   * (`'minute'`, only where `activity_bucket` is not available).
   */
  activitySteps?: 'bucket' | 'minute'
}

/** Earliest epoch second each relation must still expose. Absent ⇒ unbounded. */
export interface StagingBounds {
  sleepFromEpoch?: number
  activityFromEpoch?: number
}

const CATALOG_RE = /^[a-z_]\w*$/i
const QUOTE_RE = /'/g

function lit(s: string): string {
  return `'${s.replace(QUOTE_RE, '\'\'')}'`
}

/** ` AND ts >= <one second below the bound>`, or nothing. */
function since(fromEpoch: number | undefined): string {
  if (fromEpoch === undefined)
    return ''
  if (!Number.isFinite(fromEpoch))
    throw new Error(`sleep-correction: non-finite staging bound ${String(fromEpoch)}`)
  const iso = new Date((Math.floor(fromEpoch) - 1) * 1000).toISOString().slice(0, 19).replace('T', ' ')
  return ` AND ts >= TIMESTAMP '${iso}'`
}

function activityViewSql(name: string, tenant: string, bound: string, steps: 'bucket' | 'minute'): string {
  if (steps === 'minute') {
    return `CREATE OR REPLACE TEMP VIEW ${name} AS
SELECT CAST(epoch(ts) AS BIGINT) AS date, steps AS step
FROM v_activity
WHERE ${tenant}${bound}`
  }
  // SUM over INTEGER is HUGEINT, which not every binding hands back as a
  // number; the harness relation is DOUBLE, so match it.
  return `CREATE OR REPLACE TEMP VIEW ${name} AS
WITH minute AS (
    SELECT ts, steps FROM v_activity
    WHERE ${tenant}${bound}
),
bucket AS (
    SELECT ts FROM v_activity_bucket
    WHERE ${tenant}${bound}
)
SELECT CAST(epoch(b.ts) AS BIGINT) AS date, CAST(SUM(m.steps) AS DOUBLE) AS step
FROM minute m ASOF JOIN bucket b ON m.ts >= b.ts
WHERE m.ts < b.ts + INTERVAL 10 MINUTE
GROUP BY b.ts`
}

/** `CREATE OR REPLACE TEMP VIEW` statements for the three staging relations. */
export function stagingViewsSql(
  scope: StagingScope,
  r: SleepRelations = DEFAULT_RELATIONS,
  bounds: StagingBounds = {},
): string[] {
  const catalog = scope.localCatalog ?? 'memory'
  if (!CATALOG_RE.test(catalog))
    throw new Error(`sleep-correction: invalid catalog ${JSON.stringify(catalog)}`)
  const tenant = `user_id = ${lit(scope.userId)} AND device_id = ${lit(scope.deviceId)}`
  return [
    `CREATE OR REPLACE TEMP VIEW ${rel(r.sleep)} AS
SELECT CAST(epoch(ts) AS BIGINT) AS date,
       quality,
       CAST(epoch(ts_session_start) AS BIGINT) AS start,
       unit_length AS "unitLength"
FROM ${catalog}.main.sleep_raw
WHERE brand = ${lit(scope.brand)} AND family_id = ${lit(scope.familyId)} AND ${tenant}${since(bounds.sleepFromEpoch)}`,
    `CREATE OR REPLACE TEMP VIEW ${rel(r.heartrate)} AS
SELECT CAST(epoch(ts) AS BIGINT) AS date, bpm AS "singleHR"
FROM v_heart_rate
WHERE ${tenant}`,
    activityViewSql(rel(r.activity), tenant, since(bounds.activityFromEpoch), scope.activitySteps ?? 'bucket'),
  ]
}
