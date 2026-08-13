/**
 * Pending SCD-2 closes queue (T-08 continuation).
 *
 * `mapRingConfig` emits `RingConfigClose[]` whenever a firmware ring-config
 * snapshot supersedes a currently-open `device_config` row. Local UPDATE
 * fires in-line inside `pushFirmware`; the remote UPDATE (against the
 * Iceberg zone via DuckDB) runs on the next scheduler cycle so it inherits
 * the same retry/backoff semantics as the INSERT pusher.
 *
 * Between those two moments the sink parks the close directives here. The
 * enqueue happens *before* local UPDATE so a crash in between leaves a
 * replay-safe record — the remote UPDATE is idempotent thanks to the
 * `valid_to IS NULL` guard in `R2Pusher.pushCloses`.
 *
 * Key convention:
 *   `analytics:pending_closes:{brand}:{tenantId}` → JSON array of the
 *   serialized close shape.
 *
 * Serialization: `Date → ISO string`, restored to `Date` on drain.
 */

import type { AttachContext, KVStore } from '../core/types'

import type { RingConfigClose } from './mapper/ring-config'

const KEY_PREFIX = 'analytics:pending_closes'

interface SerializedClose {
  device_id: string
  metric: string
  valid_to: string
}

function key(ctx: Pick<AttachContext, 'brand' | 'tenantId'>): string {
  return `${KEY_PREFIX}:${ctx.brand}:${ctx.tenantId}`
}

function serialize(close: RingConfigClose): SerializedClose {
  return {
    device_id: close.device_id,
    metric: close.metric,
    valid_to: close.valid_to.toISOString(),
  }
}

function deserialize(row: SerializedClose): RingConfigClose {
  return {
    device_id: row.device_id,
    metric: row.metric,
    valid_to: new Date(row.valid_to),
  }
}

export class PendingClosesStore {
  readonly #kv: KVStore

  constructor(kv: KVStore) {
    this.#kv = kv
  }

  async enqueue(
    ctx: Pick<AttachContext, 'brand' | 'tenantId'>,
    closes: readonly RingConfigClose[],
  ): Promise<void> {
    if (closes.length === 0)
      return
    const k = key(ctx)
    const existing = (await this.#kv.get<SerializedClose[]>(k)) ?? []
    const next = [...existing, ...closes.map(serialize)]
    await this.#kv.set(k, next)
  }

  async drain(
    ctx: Pick<AttachContext, 'brand' | 'tenantId'>,
  ): Promise<RingConfigClose[]> {
    const k = key(ctx)
    const rows = (await this.#kv.get<SerializedClose[]>(k)) ?? []
    if (rows.length === 0)
      return []
    await this.#kv.delete(k)
    return rows.map(deserialize)
  }

  async requeue(
    ctx: Pick<AttachContext, 'brand' | 'tenantId'>,
    closes: readonly RingConfigClose[],
  ): Promise<void> {
    if (closes.length === 0)
      return
    const k = key(ctx)
    const existing = (await this.#kv.get<SerializedClose[]>(k)) ?? []
    // Prepend the requeued closes so the next drain retries them first.
    const next = [...closes.map(serialize), ...existing]
    await this.#kv.set(k, next)
  }
}
