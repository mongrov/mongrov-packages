/**
 * Thin wrapper around a native DuckDB instance.
 *
 * Owns lifecycle (`open`/`close`), maps native errors into the analytics
 * error taxonomy, and normalises `execute`/`stream`/`createAppender` so the
 * rest of the package doesn't touch `react-native-duckdb` directly.
 *
 * We depend on `react-native-duckdb` only structurally (via the
 * `DuckDBInstance` interface below) so the package builds and tests without
 * the native module installed. The public factory (T-10) supplies a real
 * instance via a `DuckDBFactory`; test suites supply fakes.
 */

import { AnalyticsError } from './errors'

/**
 * Minimal structural type for the underlying DuckDB connection.
 *
 * Anything the real `react-native-duckdb` connection offers beyond this is
 * ignored — we only lean on what spec §Engine + downstream phases need.
 */
export interface DuckDBInstance {
  execute: (sql: string, params?: Record<string, unknown>) => Promise<unknown[]>
  stream: (sql: string, params?: Record<string, unknown>) => AsyncIterable<unknown[]>
  createAppender: (table: string) => DuckDBAppender
  close: () => Promise<void>
}

export interface DuckDBAppender {
  appendRow: (values: unknown[]) => void
  flush: () => void
  close: () => void
}

/** Factory that yields a DuckDB instance (native or fake). */
export type DuckDBFactory = () => Promise<DuckDBInstance>

/**
 * Owns the DuckDB connection lifecycle.
 *
 * - `open()` is idempotent: repeated calls after a successful open are no-ops.
 * - `close()` is idempotent and terminal — subsequent `execute`/`stream`/
 *   `createAppender` throw `not_ready`.
 * - `execute()` returns a full row set; `stream()` yields pages of rows
 *   (recommended page size `HybridDuckDB.PAGE_SIZE`, applied by the native
 *   driver; the wrapper just forwards).
 * - Any native throw is wrapped in `AnalyticsError`.
 */
export class HybridDuckDB {
  /** Recommended page size for streamed queries (spec §Engine). */
  static readonly PAGE_SIZE = 500

  #factory: DuckDBFactory
  #instance: DuckDBInstance | undefined
  #closed = false

  constructor(factory: DuckDBFactory) {
    this.#factory = factory
  }

  /** Whether `open()` has completed successfully and `close()` has not been called. */
  get isOpen(): boolean {
    return this.#instance !== undefined && !this.#closed
  }

  async open(): Promise<void> {
    if (this.#closed) {
      throw new AnalyticsError('not_ready', 'HybridDuckDB has been closed')
    }
    if (this.#instance) {
      return
    }
    try {
      this.#instance = await this.#factory()
    }
    catch (cause) {
      throw new AnalyticsError('engine_open_failed', 'Failed to open DuckDB instance', cause)
    }
  }

  async execute<T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
    const inst = this.#ready()
    try {
      const rows = await inst.execute(sql, params)
      return rows as T[]
    }
    catch (cause) {
      throw new AnalyticsError('query_failed', `execute failed: ${previewSql(sql)}`, cause)
    }
  }

  async* stream<T = unknown>(
    sql: string,
    params?: Record<string, unknown>,
  ): AsyncIterable<T[]> {
    const inst = this.#ready()
    try {
      for await (const page of inst.stream(sql, params)) {
        yield page as T[]
      }
    }
    catch (cause) {
      throw new AnalyticsError('query_failed', `stream failed: ${previewSql(sql)}`, cause)
    }
  }

  createAppender(table: string): DuckDBAppender {
    const inst = this.#ready()
    try {
      return inst.createAppender(table)
    }
    catch (cause) {
      throw new AnalyticsError(
        'query_failed',
        `createAppender failed for table ${table}`,
        cause,
      )
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true
    const inst = this.#instance
    this.#instance = undefined
    if (inst) {
      await inst.close()
    }
  }

  #ready(): DuckDBInstance {
    if (this.#closed) {
      throw new AnalyticsError('not_ready', 'HybridDuckDB is closed')
    }
    if (!this.#instance) {
      throw new AnalyticsError('not_ready', 'HybridDuckDB.open() has not been called')
    }
    return this.#instance
  }
}

function previewSql(sql: string): string {
  return sql.length > 120 ? `${sql.slice(0, 120)}…` : sql
}
