/**
 * Batched writer for `tool_call_audit`.
 *
 * `record()` enqueues synchronously (non-blocking). The batch flushes
 * whenever:
 *   - the pending queue reaches `batchSize` (default 10), or
 *   - the flush timer fires (`flushIntervalMs`, default 1000ms).
 *
 * `flush()` and `close()` are cooperative exit hooks — `close`
 * additionally halts the timer.
 *
 * On flush failure the batch is retained and retried on the next
 * tick. A defensive `MAX_CONSECUTIVE_FAILURES` cap drops the buffer
 * after repeated errors to avoid unbounded growth on a stuck
 * warehouse.
 *
 * SQL uses a single INSERT with a suffix-indexed VALUES tuple per
 * row (`$p0_ts, $p0_brand, …, $p1_ts, …`). DuckDB honors named
 * parameters in this form.
 */

import type { AnalyticsEngine } from '../core/types'
import type { AuditEntry, AuditWriter, ToolsLogger } from './types'

const DEFAULT_BATCH_SIZE = 10
const DEFAULT_FLUSH_INTERVAL_MS = 1000
const MAX_CONSECUTIVE_FAILURES = 5

const COLUMNS = [
  'ts',
  'brand',
  'family_id',
  'requester_user_id',
  'tool_name',
  'args',
  'result_bytes',
  'result_row_count',
  'latency_ms',
  'outcome',
  'error_message',
] as const

export interface CreateAuditWriterConfig {
  analytics: AnalyticsEngine
  enabled?: boolean
  batchSize?: number
  flushIntervalMs?: number
  logger?: ToolsLogger
}

export function createAuditWriter(cfg: CreateAuditWriterConfig): AuditWriter {
  const enabled = cfg.enabled ?? true
  const batchSize = cfg.batchSize ?? DEFAULT_BATCH_SIZE
  const flushIntervalMs = cfg.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  const logger = cfg.logger

  const pending: AuditEntry[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  let consecutiveFailures = 0
  let inFlight: Promise<void> | null = null
  let closed = false

  function ensureTimer(): void {
    if (timer || closed)
      return
    timer = setInterval(() => {
      void doFlush()
    }, flushIntervalMs)
    // Node timers are keep-alive by default; unref so a lingering
    // audit writer doesn't block process exit.
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref()
    }
  }

  function clearFlushTimer(): void {
    if (!timer)
      return
    clearInterval(timer)
    timer = null
  }

  async function doFlush(): Promise<void> {
    if (inFlight)
      return inFlight
    if (pending.length === 0)
      return
    const batch = pending.splice(0, pending.length)
    inFlight = (async () => {
      try {
        await writeBatch(cfg.analytics, batch)
        consecutiveFailures = 0
      }
      catch (err) {
        consecutiveFailures += 1
        const errMsg = err instanceof Error ? err.message : String(err)
        logger?.warn('audit flush failed', {
          err: errMsg,
          batchSize: batch.length,
          consecutiveFailures,
        })
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logger?.error('audit flush cap reached, dropping batch', {
            droppedRows: batch.length,
          })
          consecutiveFailures = 0
        }
        else {
          // Retain: prepend so retry preserves order.
          pending.unshift(...batch)
        }
      }
      finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  return {
    record(entry) {
      if (!enabled || closed)
        return
      pending.push(entry)
      ensureTimer()
      if (pending.length >= batchSize) {
        void doFlush()
      }
    },
    async flush() {
      if (!enabled)
        return
      await doFlush()
      // If the flush swallowed a failure and re-queued, drain once
      // more so callers get a best-effort guarantee.
      if (pending.length > 0) {
        await doFlush()
      }
    },
    async close() {
      closed = true
      clearFlushTimer()
      if (!enabled)
        return
      await doFlush()
      if (pending.length > 0) {
        await doFlush()
      }
    },
  }
}

async function writeBatch(
  analytics: AnalyticsEngine,
  batch: AuditEntry[],
): Promise<void> {
  if (batch.length === 0)
    return

  const tuples: string[] = []
  const params: Record<string, unknown> = {}

  batch.forEach((entry, i) => {
    const prefix = `p${i}`
    const placeholders = COLUMNS.map(col => `$${prefix}_${col}`)
    tuples.push(`(${placeholders.join(', ')})`)

    params[`${prefix}_ts`] = entry.ts
    params[`${prefix}_brand`] = entry.brand
    params[`${prefix}_family_id`] = entry.familyId
    params[`${prefix}_requester_user_id`] = entry.requesterUserId
    params[`${prefix}_tool_name`] = entry.toolName
    params[`${prefix}_args`] = JSON.stringify(entry.args)
    params[`${prefix}_result_bytes`] = entry.resultBytes
    params[`${prefix}_result_row_count`] = entry.resultRowCount
    params[`${prefix}_latency_ms`] = entry.latencyMs
    params[`${prefix}_outcome`] = entry.outcome
    params[`${prefix}_error_message`] = entry.errorMessage
  })

  const sql
    = `INSERT INTO tool_call_audit (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`

  await analytics.execute(sql, params)
}
