/**
 * R2 pusher (T-17 + T-18).
 *
 * Pushes per-table deltas from the local DuckDB warehouse to the attached R2
 * Iceberg zone. Each table push:
 *   1. Reads the push watermark for `(brand, familyId, table)`.
 *   2. Computes the max `ts` currently in local for that filter.
 *   3. Issues `INSERT INTO <remote>.<table> SELECT * FROM <local>.<table>
 *      WHERE ts > $watermark AND family_id = $familyId`.
 *   4. On success, advances the watermark to the max `ts` observed.
 *
 * Auth recovery (spec §R2 pusher): a 401 triggers `refreshToken()` and one
 * retry. Other errors preserve the watermark so nothing is lost.
 *
 * Parallel push (T-18): `pushAll(tables, ctx)` fans out via
 * `Promise.allSettled` so per-table failures don't hold up the rest.
 */

import type { HybridDuckDB } from '../core/engine'
import { timeColumnFor } from '../core/table_metadata'
import type { AttachContext } from '../core/types'
import { SyncError } from './errors'
import type { PushEmitter } from './events'
import type { RingConfigClose } from './mapper/ring-config'
import type { WatermarkStore } from './watermark'

export interface PushResult {
  table: string
  rowsPushed: number
  ok: boolean
  error?: SyncError
}

export interface R2PusherConfig {
  engine: HybridDuckDB
  watermark: WatermarkStore
  /** Refresh the attach token on 401. Called once per push before retrying. */
  refreshToken?: () => Promise<void>
  /**
   * Detects a 401 from an arbitrary thrown value. Defaults to a `.message`
   * substring match on '401' or 'unauthorized'.
   */
  is401?: (err: unknown) => boolean
  /**
   * SQL name builders. Defaults follow the 0.5.0 warehouse convention:
   *   local  = `main.<table>`               (current catalog's main schema)
   *   remote = `zone_<familyId>.default.<table>`  (3-part, iceberg namespace)
   *
   * The 3-part remote form is required because 0.5.0's `attachWarehouse`
   * no longer does `USE ${secretName}.default` after ATTACH — see
   * `core/warehouse.ts` top-of-file NOTE. A 2-part `zone_<id>.<table>`
   * would resolve `<table>` against current_schema (`main`), but iceberg
   * catalogs only expose `default`.
   *
   * Override if the warehouse module produces different aliases.
   */
  localTable?: (ctx: AttachContext, table: string) => string
  remoteTable?: (ctx: AttachContext, table: string) => string
  /**
   * Optional event-bus adapter. Emits `${table}:sync_complete` after each
   * successful push. See `events.ts` / `bindPushEvents()`.
   */
  emit?: PushEmitter
}

const DEFAULT_IS_401 = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false
  const msg = String((err as { message?: unknown }).message ?? '').toLowerCase()
  return msg.includes('401') || msg.includes('unauthorized')
}

const DEFAULT_LOCAL = (_c: AttachContext, table: string) => `main.${table}`
const DEFAULT_REMOTE = (c: AttachContext, table: string) =>
  `zone_${c.tenantId}.default.${table}`

export class R2Pusher {
  readonly #engine: HybridDuckDB
  readonly #watermark: WatermarkStore
  readonly #refreshToken: (() => Promise<void>) | undefined
  readonly #is401: (err: unknown) => boolean
  readonly #localTable: (ctx: AttachContext, table: string) => string
  readonly #remoteTable: (ctx: AttachContext, table: string) => string
  readonly #emit: PushEmitter | undefined

  constructor(config: R2PusherConfig) {
    this.#engine = config.engine
    this.#watermark = config.watermark
    this.#refreshToken = config.refreshToken
    this.#is401 = config.is401 ?? DEFAULT_IS_401
    this.#localTable = config.localTable ?? DEFAULT_LOCAL
    this.#remoteTable = config.remoteTable ?? DEFAULT_REMOTE
    this.#emit = config.emit
  }

  async push(table: string, ctx: AttachContext): Promise<PushResult> {
    const result = await this.#pushOrCatch(table, ctx)
    this.#emit?.(result)
    return result
  }

  async #pushOrCatch(table: string, ctx: AttachContext): Promise<PushResult> {
    try {
      return await this.#pushOnce(table, ctx)
    }
    catch (err) {
      if (this.#is401(err) && this.#refreshToken) {
        try {
          await this.#refreshToken()
          return await this.#pushOnce(table, ctx)
        }
        catch (retryErr) {
          return this.#toFailure(table, retryErr, 'token_expired')
        }
      }
      return this.#toFailure(table, err, 'push_failed')
    }
  }

  /**
   * SCD-2 close directives → remote UPDATE (T-08 continuation).
   *
   * Each close becomes:
   *   UPDATE <remote>.device_config
   *      SET valid_to = $valid_to
   *    WHERE device_id = $device_id
   *      AND data_type = $data_type
   *      AND family_id = $family_id
   *      AND valid_to IS NULL
   *
   * The `valid_to IS NULL` guard makes replaying the same close a no-op,
   * which is what lets the `PendingClosesStore` + scheduler retry cycle
   * survive crashes between local UPDATE and remote UPDATE.
   *
   * 401 handling mirrors `#pushOrCatch`: one `refreshToken()` + retry, then
   * surface `token_expired`. Other errors surface `push_failed` and leave
   * the caller responsible for requeueing.
   */
  async pushCloses(
    closes: readonly RingConfigClose[],
    ctx: AttachContext,
  ): Promise<PushResult> {
    const result = await this.#pushClosesOrCatch(closes, ctx)
    this.#emit?.(result)
    return result
  }

  async #pushClosesOrCatch(
    closes: readonly RingConfigClose[],
    ctx: AttachContext,
  ): Promise<PushResult> {
    try {
      return await this.#pushClosesOnce(closes, ctx)
    }
    catch (err) {
      if (this.#is401(err) && this.#refreshToken) {
        try {
          await this.#refreshToken()
          return await this.#pushClosesOnce(closes, ctx)
        }
        catch (retryErr) {
          return this.#toFailure('device_config', retryErr, 'token_expired')
        }
      }
      return this.#toFailure('device_config', err, 'push_failed')
    }
  }

  async #pushClosesOnce(
    closes: readonly RingConfigClose[],
    ctx: AttachContext,
  ): Promise<PushResult> {
    if (closes.length === 0) {
      return { table: 'device_config', rowsPushed: 0, ok: true }
    }
    const remote = this.#remoteTable(ctx, 'device_config')
    for (const close of closes) {
      await this.#engine.execute(
        `UPDATE ${remote} SET valid_to = $valid_to WHERE device_id = $device_id AND metric = $metric AND family_id = $family_id AND valid_to IS NULL`,
        {
          valid_to: close.valid_to.toISOString(),
          device_id: close.device_id,
          metric: close.metric,
          family_id: ctx.tenantId,
        },
      )
    }
    return { table: 'device_config', rowsPushed: closes.length, ok: true }
  }

  async pushAll(
    tables: readonly string[],
    ctx: AttachContext,
  ): Promise<PushResult[]> {
    const settled = await Promise.allSettled(
      tables.map(t => this.push(t, ctx)),
    )
    return settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value
      const err = r.reason instanceof SyncError
        ? r.reason
        : new SyncError('push_failed', 'push rejected', r.reason)
      return { table: tables[i]!, rowsPushed: 0, ok: false, error: err }
    })
  }

  async #pushOnce(table: string, ctx: AttachContext): Promise<PushResult> {
    const tsCol = timeColumnFor(table)
    const watermark = await this.#watermark.get(
      ctx.brand,
      ctx.tenantId,
      table,
      'push',
    )
    const local = this.#localTable(ctx, table)
    const remote = this.#remoteTable(ctx, table)

    // Max ts to advance the watermark to. Null result → no new rows.
    const maxRows = await this.#engine.execute(
      `SELECT MAX(${tsCol}) AS max_ts, COUNT(*) AS row_count FROM ${local} WHERE ${tsCol} > $watermark AND family_id = $familyId`,
      { watermark: watermark.toISOString(), familyId: ctx.tenantId },
    ) as Array<{ max_ts?: string | null, row_count?: number }>

    const first = maxRows[0]
    const rowCount = Number(first?.row_count ?? 0)
    if (rowCount === 0) {
      return { table, rowsPushed: 0, ok: true }
    }

    await this.#engine.execute(
      `INSERT INTO ${remote} SELECT * FROM ${local} WHERE ${tsCol} > $watermark AND family_id = $familyId`,
      { watermark: watermark.toISOString(), familyId: ctx.tenantId },
    )

    if (first?.max_ts) {
      const nextWatermark = new Date(first.max_ts)
      if (!Number.isNaN(nextWatermark.getTime())) {
        await this.#watermark.advance(
          ctx.brand,
          ctx.tenantId,
          table,
          'push',
          nextWatermark,
        )
      }
    }

    return { table, rowsPushed: rowCount, ok: true }
  }

  #toFailure(
    table: string,
    cause: unknown,
    code: 'push_failed' | 'token_expired',
  ): PushResult {
    const err = cause instanceof SyncError
      ? cause
      : new SyncError(code, `push failed for ${table}`, cause)
    return { table, rowsPushed: 0, ok: false, error: err }
  }
}
