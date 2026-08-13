/**
 * In-memory fake matching the structural `DuckDBInstance` type from
 * `../../engine`. Captures issued SQL for test assertions and lets tests
 * script `execute`/`stream`/`createAppender` return values or errors.
 *
 * Not a test file itself (no `.test.ts` suffix), so vitest's `include`
 * glob skips it; the coverage `exclude` also drops the `__tests__/` prefix.
 */

import type { DuckDBAppender, DuckDBFactory, DuckDBInstance } from '../../engine'

export interface FakeSqlCall {
  sql: string
  params: Record<string, unknown> | undefined
}

export interface FakeAppenderCall {
  table: string
  rows: unknown[][]
  flushed: number
  closed: boolean
}

export interface FakeDuckDB {
  instance: DuckDBInstance
  factory: DuckDBFactory
  /** Every SQL sent via execute/stream, in order. */
  calls: FakeSqlCall[]
  /** Every appender opened, in order (each captures its own rows/flushes). */
  appenders: FakeAppenderCall[]
  /** How many times `close()` has been invoked on the instance. */
  closeCount: number
  /** How many times the factory produced an instance. */
  factoryCount: number
  /** Script the next `execute()` to throw. */
  failNextExecute: (err: unknown) => void
  /**
   * Script every subsequent `execute()` whose SQL matches `pattern` to throw
   * `err`. Persists until cleared via `clearExecuteMatchFailure`.
   */
  failExecuteMatching: (pattern: RegExp, err: unknown) => void
  /** Clear a pattern-based failure set via `failExecuteMatching`. */
  clearExecuteMatchFailure: () => void
  /** Script the next `execute()` to return specific rows. */
  setNextExecuteRows: (rows: unknown[]) => void
  /** Script `stream()` to yield these pages once. */
  setNextStreamPages: (pages: unknown[][]) => void
  /** Script `stream()` to throw mid-iteration. */
  failNextStream: (err: unknown) => void
  /** Script the next `createAppender()` call to throw. */
  failNextCreateAppender: (err: unknown) => void
}

export interface CreateFakeDuckDBOptions {
  /** Throw from the factory itself on `open()`. */
  failOnOpen?: unknown
}

/**
 * Build a fresh fake DuckDB and matching factory.
 *
 * Tests call `createFakeDuckDB()` per test and pass `.factory` into
 * `new HybridDuckDB(fake.factory)`.
 */
export function createFakeDuckDB(options: CreateFakeDuckDBOptions = {}): FakeDuckDB {
  const calls: FakeSqlCall[] = []
  const appenders: FakeAppenderCall[] = []

  let nextExecuteRows: unknown[] | undefined
  let nextExecuteError: unknown
  let matchExecuteError: { pattern: RegExp, err: unknown } | undefined
  let nextStreamPages: unknown[][] | undefined
  let nextStreamError: unknown
  let nextAppenderError: unknown

  const state = {
    closeCount: 0,
    factoryCount: 0,
  }

  const instance: DuckDBInstance = {
    async execute(sql, params) {
      calls.push({ sql, params })
      if (nextExecuteError !== undefined) {
        const err = nextExecuteError
        nextExecuteError = undefined
        throw err
      }
      if (matchExecuteError && matchExecuteError.pattern.test(sql)) {
        throw matchExecuteError.err
      }
      const rows = nextExecuteRows ?? []
      nextExecuteRows = undefined
      return rows
    },
    async* stream(sql, params) {
      calls.push({ sql, params })
      const pages = nextStreamPages ?? []
      nextStreamPages = undefined
      for (const page of pages) {
        if (nextStreamError !== undefined) {
          const err = nextStreamError
          nextStreamError = undefined
          throw err
        }
        yield page
      }
      if (nextStreamError !== undefined) {
        const err = nextStreamError
        nextStreamError = undefined
        throw err
      }
    },
    createAppender(table) {
      if (nextAppenderError !== undefined) {
        const err = nextAppenderError
        nextAppenderError = undefined
        throw err
      }
      const record: FakeAppenderCall = {
        table,
        rows: [],
        flushed: 0,
        closed: false,
      }
      appenders.push(record)
      const appender: DuckDBAppender = {
        appendRow(values) {
          record.rows.push(values)
        },
        flush() {
          record.flushed += 1
        },
        close() {
          record.closed = true
        },
      }
      return appender
    },
    async close() {
      state.closeCount += 1
    },
  }

  const factory: DuckDBFactory = async () => {
    state.factoryCount += 1
    if (options.failOnOpen !== undefined) {
      throw options.failOnOpen
    }
    return instance
  }

  return {
    instance,
    factory,
    calls,
    appenders,
    get closeCount() {
      return state.closeCount
    },
    get factoryCount() {
      return state.factoryCount
    },
    failNextExecute(err) {
      nextExecuteError = err
    },
    failExecuteMatching(pattern, err) {
      matchExecuteError = { pattern, err }
    },
    clearExecuteMatchFailure() {
      matchExecuteError = undefined
    },
    setNextExecuteRows(rows) {
      nextExecuteRows = rows
    },
    setNextStreamPages(pages) {
      nextStreamPages = pages
    },
    failNextStream(err) {
      nextStreamError = err
    },
    failNextCreateAppender(err) {
      nextAppenderError = err
    },
  }
}
