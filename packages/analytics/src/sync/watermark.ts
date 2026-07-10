/**
 * Watermark store (T-16).
 *
 * Two independent cursors per `(brand, familyId, table)` pair:
 *   - `push` — highest `ts` we've successfully written to R2. Advances on
 *     every successful pusher round.
 *   - `fetch` — highest `ts` we've pulled from R2 into the local warehouse.
 *     Advances on every successful fetcher round.
 *
 * Key convention (spec §Watermark):
 *   `analytics:watermark:{brand}:{familyId}:{table}:{kind}` → ISO string
 *
 * Missing key defaults to `now() - retentionMs`. Default retention is 30 days
 * so a fresh install pushes/fetches at most the last month rather than
 * unbounded history.
 */

import type { KVStore } from '../core/types'

const KEY_PREFIX = 'analytics:watermark'
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export type WatermarkKind = 'push' | 'fetch'

export interface WatermarkStoreConfig {
  kv: KVStore
  /** Injected clock for tests. Defaults to `() => new Date()`. */
  now?: () => Date
  /** Fresh-install horizon. Defaults to 30 days. */
  defaultRetentionMs?: number
}

function key(
  brand: string,
  familyId: string,
  table: string,
  kind: WatermarkKind,
): string {
  return `${KEY_PREFIX}:${brand}:${familyId}:${table}:${kind}`
}

export class WatermarkStore {
  readonly #kv: KVStore
  readonly #now: () => Date
  readonly #defaultRetentionMs: number

  constructor(config: WatermarkStoreConfig) {
    this.#kv = config.kv
    this.#now = config.now ?? (() => new Date())
    this.#defaultRetentionMs = config.defaultRetentionMs ?? DEFAULT_RETENTION_MS
  }

  async get(
    brand: string,
    familyId: string,
    table: string,
    kind: WatermarkKind,
  ): Promise<Date> {
    const iso = await this.#kv.get<string>(key(brand, familyId, table, kind))
    if (iso && typeof iso === 'string') {
      const parsed = new Date(iso)
      if (!Number.isNaN(parsed.getTime())) return parsed
    }
    return new Date(this.#now().getTime() - this.#defaultRetentionMs)
  }

  async advance(
    brand: string,
    familyId: string,
    table: string,
    kind: WatermarkKind,
    ts: Date,
  ): Promise<void> {
    // Never regress — only accept advances forward.
    const current = await this.get(brand, familyId, table, kind)
    if (ts <= current) return
    await this.#kv.set(key(brand, familyId, table, kind), ts.toISOString())
  }
}
