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
 * - HR and steps come from `v_heart_rate` / `v_activity`, so a 30-day
 *   baseline lookback sees remote history too.
 * - One user and one device: the correction is per ring.
 *
 * `sleep_raw.quality` must hold the firmware's own codes (1 deep / 2 light /
 * 3 rem / 5 awake). That is true only once the producer sends raw rows
 * (sleep-correction tasks §3); until then these views are exercised by tests.
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
 *
 * Heart rate takes no bound: `detectHrTierSql` reads its whole history.
 */

import type { SleepRelations } from './sql'

import { DEFAULT_RELATIONS } from './sql'

export interface StagingScope {
  brand: string
  familyId: string
  userId: string
  deviceId: string
  /** Local DuckDB catalog holding `sleep_raw`. */
  localCatalog?: string
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
    `CREATE OR REPLACE TEMP VIEW ${r.sleep} AS
SELECT CAST(epoch(ts) AS BIGINT) AS date,
       quality,
       CAST(epoch(ts_session_start) AS BIGINT) AS start,
       unit_length AS "unitLength"
FROM ${catalog}.main.sleep_raw
WHERE brand = ${lit(scope.brand)} AND family_id = ${lit(scope.familyId)} AND ${tenant}${since(bounds.sleepFromEpoch)}`,
    `CREATE OR REPLACE TEMP VIEW ${r.heartrate} AS
SELECT CAST(epoch(ts) AS BIGINT) AS date, bpm AS "singleHR"
FROM v_heart_rate
WHERE ${tenant}`,
    `CREATE OR REPLACE TEMP VIEW ${r.activity} AS
SELECT CAST(epoch(ts) AS BIGINT) AS date, steps AS step
FROM v_activity
WHERE ${tenant}${since(bounds.activityFromEpoch)}`,
  ]
}
