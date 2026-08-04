/**
 * R2 fetcher (T-19 + T-20 + T-21).
 *
 * Reads-back path from the attached R2 Iceberg zone into the local DuckDB
 * warehouse.
 *
 * Three modes:
 *   - `prefetchOnAttach(ctx, policy)` — one-shot bulk pull immediately after
 *     `analytics.attach()`, driven by a policy:
 *       * `all-family-on-attach` — every family row within `windowDays`
 *       * `recent-active-only`   — active users first (CTE)
 *       * `lazy`                 — no-op
 *   - `fetchIncremental(ctx)`  — pulls only rows newer than the fetch
 *     watermark; `ON CONFLICT DO NOTHING` keeps re-runs idempotent.
 *   - `fetchOnDemand(ctx, params)` — bypasses watermark; caller-supplied
 *     bounds (`since`, optional `until`, optional `limit`).
 *
 * Every path advances the fetch watermark on success so subsequent
 * incremental pulls stay bounded.
 */

import type { HybridDuckDB } from '../core/engine'
import { SCHEMAS, type TableName } from '../core/schemas'
import { timeColumnFor } from '../core/table_metadata'
import type { AttachContext } from '../core/types'
import { SyncError } from './errors'
import type { WatermarkStore } from './watermark'

/**
 * `ON CONFLICT DO NOTHING` for idempotent re-fetch — but only on tables
 * that actually declare a PRIMARY KEY. DuckDB ≥1.5 rejects a blanket
 * `ON CONFLICT` on key-less tables ("no UNIQUE/PRIMARY KEY constraints
 * that refer to this table"); for those, watermark advancement is the
 * dedupe guard.
 */
function conflictClause(table: string): string {
  const ddl = (SCHEMAS as Record<string, string>)[table as TableName]
  return ddl?.includes('PRIMARY KEY') ? ' ON CONFLICT DO NOTHING' : ''
}

export type PrefetchPolicy
  = | { kind: 'all-family-on-attach', windowDays: number }
    | { kind: 'recent-active-only', activeDays: number, windowDays: number }
    | { kind: 'lazy' }

export interface FetchResult {
  table: string
  rowsFetched: number
  ok: boolean
  error?: SyncError
}

export interface FetchParams {
  table: string
  since: Date
  until?: Date
  limit?: number
}

export interface R2FetcherConfig {
  engine: HybridDuckDB
  watermark: WatermarkStore
  /** Tables that participate in prefetch / incremental fetch. */
  tables: readonly string[]
  now?: () => Date
  localTable?: (ctx: AttachContext, table: string) => string
  remoteTable?: (ctx: AttachContext, table: string) => string
}

const DEFAULT_LOCAL = (_c: AttachContext, table: string) => `main.${table}`
// 3-part remote for the same reason pusher's is 3-part — see pusher.ts.
const DEFAULT_REMOTE = (c: AttachContext, table: string) =>
  `zone_${c.tenantId}.default.${table}`

export class R2Fetcher {
  readonly #engine: HybridDuckDB
  readonly #watermark: WatermarkStore
  readonly #tables: readonly string[]
  readonly #now: () => Date
  readonly #localTable: (ctx: AttachContext, table: string) => string
  readonly #remoteTable: (ctx: AttachContext, table: string) => string

  constructor(config: R2FetcherConfig) {
    this.#engine = config.engine
    this.#watermark = config.watermark
    this.#tables = config.tables
    this.#now = config.now ?? (() => new Date())
    this.#localTable = config.localTable ?? DEFAULT_LOCAL
    this.#remoteTable = config.remoteTable ?? DEFAULT_REMOTE
  }

  /**
   * T-19: one-shot bulk fetch keyed by policy. Returns per-table results so
   * partial failure is observable.
   */
  async prefetchOnAttach(
    ctx: AttachContext,
    policy: PrefetchPolicy,
  ): Promise<FetchResult[]> {
    if (policy.kind === 'lazy') {
      return this.#tables.map(t => ({ table: t, rowsFetched: 0, ok: true }))
    }

    const cutoffMs = this.#now().getTime() - policy.windowDays * 24 * 60 * 60 * 1000
    const cutoff = new Date(cutoffMs).toISOString()

    const settled = await Promise.allSettled(
      this.#tables.map(table =>
        this.#prefetchOne(ctx, table, policy, cutoff),
      ),
    )
    return settled.map((r, i) => {
      const table = this.#tables[i]!
      if (r.status === 'fulfilled') return r.value
      return this.#toFailure(table, r.reason)
    })
  }

  /**
   * T-20: pulls only rows newer than the fetch watermark; idempotent.
   */
  async fetchIncremental(ctx: AttachContext): Promise<FetchResult[]> {
    const settled = await Promise.allSettled(
      this.#tables.map(table => this.#fetchIncrementalOne(ctx, table)),
    )
    return settled.map((r, i) => {
      const table = this.#tables[i]!
      if (r.status === 'fulfilled') return r.value
      return this.#toFailure(table, r.reason)
    })
  }

  /**
   * T-21: caller-driven fetch that bypasses the watermark for the *read*
   * but still advances it afterwards so incremental pulls stay bounded.
   *
   * Watermark rule (fix SY-1): the watermark may only cover rows that are
   * actually in the local warehouse. When `limit` truncates the result,
   * rows in `(watermark, until]` beyond the cut were never inserted —
   * advancing to `until` would make them permanently invisible to
   * `fetchIncremental`. So:
   *   - truncated fetch (rowsFetched == limit) → advance only to the max
   *     `ts` actually inserted; the remainder is picked up incrementally.
   *   - un-truncated fetch (covered the full requested range, including
   *     the zero-row case) → advancing to `until` (or now()) is safe and
   *     prevents refetching empty ranges.
   *   - truncated with no anchor ts (defensive edge) → no advance.
   * `WatermarkStore.advance` still enforces never-regress on top.
   */
  async fetchOnDemand(
    ctx: AttachContext,
    params: FetchParams,
  ): Promise<FetchResult> {
    try {
      const tsCol = timeColumnFor(params.table)
      const local = this.#localTable(ctx, params.table)
      const remote = this.#remoteTable(ctx, params.table)
      const bindings: Record<string, unknown> = {
        since: params.since.toISOString(),
        familyId: ctx.tenantId,
      }
      let where = `${tsCol} >= $since AND family_id = $familyId`
      if (params.until) {
        where += ` AND ${tsCol} <= $until`
        bindings.until = params.until.toISOString()
      }
      const limit = params.limit
        ? Math.max(1, Math.floor(params.limit))
        : undefined
      // A LIMIT without ORDER BY picks arbitrary rows, which would leave
      // holes *below* the max fetched ts. Ordering by the time column makes
      // a truncated fetch a contiguous prefix, so max(ts) is a safe cursor.
      const limitClause = limit ? ` ORDER BY ${tsCol} ASC LIMIT ${limit}` : ''
      const sql = `INSERT INTO ${local} SELECT * FROM ${remote} WHERE ${where}${limitClause}${conflictClause(params.table)}`
      await this.#engine.execute(sql, bindings)

      // Stats over the same (possibly truncated) selection the INSERT saw.
      const statsSql = limit
        ? `SELECT MAX(${tsCol}) AS max_ts, COUNT(*) AS row_count FROM (SELECT ${tsCol} FROM ${remote} WHERE ${where} ORDER BY ${tsCol} ASC LIMIT ${limit}) t`
        : `SELECT MAX(${tsCol}) AS max_ts, COUNT(*) AS row_count FROM ${remote} WHERE ${where}`
      const statsRows = await this.#engine.execute(statsSql, bindings) as
        Array<{ max_ts?: string | null, row_count?: number }>
      const stats = statsRows[0]
      const rowsFetched = Number(stats?.row_count ?? 0)

      const truncated = limit !== undefined && rowsFetched >= limit
      let nextWatermark: Date | undefined
      if (truncated) {
        const maxTs = stats?.max_ts ? new Date(stats.max_ts) : undefined
        if (maxTs && !Number.isNaN(maxTs.getTime())) nextWatermark = maxTs
        // else: truncated but nothing to anchor to — leave watermark alone.
      }
      else {
        nextWatermark = params.until ?? this.#now()
      }
      if (nextWatermark) {
        await this.#watermark.advance(
          ctx.brand,
          ctx.tenantId,
          params.table,
          'fetch',
          nextWatermark,
        )
      }
      return { table: params.table, rowsFetched, ok: true }
    }
    catch (err) {
      return this.#toFailure(params.table, err)
    }
  }

  async #prefetchOne(
    ctx: AttachContext,
    table: string,
    policy: PrefetchPolicy,
    cutoff: string,
  ): Promise<FetchResult> {
    const tsCol = timeColumnFor(table)
    const local = this.#localTable(ctx, table)
    const remote = this.#remoteTable(ctx, table)

    if (policy.kind === 'all-family-on-attach') {
      const sql = `INSERT INTO ${local} SELECT * FROM ${remote} WHERE family_id = $familyId AND ${tsCol} >= $cutoff${conflictClause(table)}`
      await this.#engine.execute(sql, {
        familyId: ctx.tenantId,
        cutoff,
      })
    }
    else if (policy.kind === 'recent-active-only') {
      const activeCutoffMs = this.#now().getTime() - policy.activeDays * 24 * 60 * 60 * 1000
      const activeCutoff = new Date(activeCutoffMs).toISOString()
      // CTE picks user_ids seen in the recent window, then filters the window
      // pull down to those users.
      const sql = `WITH active AS (SELECT DISTINCT user_id FROM ${remote} WHERE family_id = $familyId AND ${tsCol} >= $activeCutoff) INSERT INTO ${local} SELECT r.* FROM ${remote} r JOIN active a ON r.user_id = a.user_id WHERE r.family_id = $familyId AND r.${tsCol} >= $cutoff${conflictClause(table)}`
      await this.#engine.execute(sql, {
        familyId: ctx.tenantId,
        cutoff,
        activeCutoff,
      })
    }

    const rowsFetched = await this.#countFetched(remote, ctx, cutoff, tsCol)
    await this.#watermark.advance(
      ctx.brand,
      ctx.tenantId,
      table,
      'fetch',
      this.#now(),
    )
    return { table, rowsFetched, ok: true }
  }

  async #fetchIncrementalOne(
    ctx: AttachContext,
    table: string,
  ): Promise<FetchResult> {
    const tsCol = timeColumnFor(table)
    const watermark = await this.#watermark.get(
      ctx.brand,
      ctx.tenantId,
      table,
      'fetch',
    )
    const local = this.#localTable(ctx, table)
    const remote = this.#remoteTable(ctx, table)
    const sql = `INSERT INTO ${local} SELECT * FROM ${remote} WHERE ${tsCol} > $watermark AND family_id = $familyId${conflictClause(table)}`
    await this.#engine.execute(sql, {
      watermark: watermark.toISOString(),
      familyId: ctx.tenantId,
    })

    const maxRows = await this.#engine.execute(
      `SELECT MAX(${tsCol}) AS max_ts, COUNT(*) AS row_count FROM ${remote} WHERE ${tsCol} > $watermark AND family_id = $familyId`,
      { watermark: watermark.toISOString(), familyId: ctx.tenantId },
    ) as Array<{ max_ts?: string | null, row_count?: number }>
    const first = maxRows[0]
    const rowsFetched = Number(first?.row_count ?? 0)
    if (first?.max_ts) {
      const nextWatermark = new Date(first.max_ts)
      if (!Number.isNaN(nextWatermark.getTime())) {
        await this.#watermark.advance(
          ctx.brand,
          ctx.tenantId,
          table,
          'fetch',
          nextWatermark,
        )
      }
    }
    return { table, rowsFetched, ok: true }
  }

  async #countFetched(
    remote: string,
    ctx: AttachContext,
    cutoff: string,
    tsCol: string,
  ): Promise<number> {
    const rows = await this.#engine.execute(
      `SELECT COUNT(*) AS c FROM ${remote} WHERE family_id = $familyId AND ${tsCol} >= $cutoff`,
      { familyId: ctx.tenantId, cutoff },
    ) as Array<{ c?: number }>
    return Number(rows[0]?.c ?? 0)
  }

  #toFailure(table: string, cause: unknown): FetchResult {
    const err = cause instanceof SyncError
      ? cause
      : new SyncError('fetch_failed', `fetch failed for ${table}`, cause)
    return { table, rowsFetched: 0, ok: false, error: err }
  }
}
