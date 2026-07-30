/**
 * `real-engine.ts` — @duckdb/node-api adapter that conforms to the
 * structural `DuckDBInstance` seam (`src/core/engine.ts`) so the
 * integration test suite can drive the SAME production factory
 * (`createAnalytics`) that ships to devices.
 *
 * Lives under `src/__integration__/` so it never enters the shipped
 * bundle: `tsconfig.build.json` excludes this whole tree, and no
 * production import path points at it.
 *
 * Design notes:
 *
 * - Iceberg + httpfs extensions are `INSTALL`'d + `LOAD`'d at connect
 *   time. `INSTALL` reaches out to the DuckDB extension repository on
 *   first use; subsequent calls resolve from the local extension cache
 *   under `~/.duckdb/`.
 *
 * - The DuckDBInstance contract expects `execute` to return a full
 *   row set and `stream` to yield pages. We fulfil both by preparing
 *   a statement, binding named params (`$name` in the SQL maps to
 *   keys in the params object), and calling `run()` for `execute` or
 *   walking the result chunks for `stream`. `DuckDBDataChunk.getRow-
 *   Objects()` needs explicit column names, which we pull off the
 *   `DuckDBResult` (they're stable across chunks).
 *
 * - `createAppender` on the DuckDBInstance seam is synchronous
 *   (`(table) => DuckDBAppender`), but `@duckdb/node-api`'s
 *   `DuckDBConnection.createAppender` is `async` even though the
 *   underlying C call (`appender_create_ext`) is synchronous. We
 *   bridge by calling `appender_create_ext` from `@duckdb/node-bindings`
 *   directly against the raw connection handle stored on
 *   `DuckDBConnection.connection`, then wrapping the result in a
 *   `DuckDBAppender` instance. This keeps the seam sync-only and
 *   avoids any interface change to production code.
 */

import bindings from '@duckdb/node-bindings'
import {
  DuckDBAppender as NodeAppender,
  DuckDBConnection,
  DuckDBInstance as NodeInstance,
  DuckDBTimestampValue,
  DuckDBValue,
} from '@duckdb/node-api'
import type { DuckDBAppender, DuckDBInstance } from '../../core/engine'

const EXTENSIONS = ['iceberg', 'httpfs']

/**
 * Boot a real Node DuckDB instance, load the extensions the integration
 * suite exercises, and adapt it to the structural `DuckDBInstance`
 * interface the analytics factory expects.
 *
 * `extensions` defaults to the remote-sync set; pass `[]` for local-mode
 * tests so they stay network-free (`INSTALL` fetches from the DuckDB
 * extension repository when the local cache is cold).
 */
export async function createRealDuckDB(
  extensions: readonly string[] = EXTENSIONS,
): Promise<DuckDBInstance> {
  const inst = await NodeInstance.create(':memory:')
  const conn = await inst.connect()
  for (const ext of extensions) {
    await conn.run(`INSTALL ${ext}`)
    await conn.run(`LOAD ${ext}`)
  }
  return adapt(inst, conn)
}

/** Reusable adapter — kept separate so setup helpers can compose it. */
function adapt(inst: NodeInstance, conn: DuckDBConnection): DuckDBInstance {
  return {
    async execute(sql, params) {
      if (!params || Object.keys(params).length === 0) {
        const r = await conn.run(sql)
        return normaliseRows(await r.getRowObjects())
      }
      const stmt = await conn.prepare(sql)
      stmt.bind(params as Record<string, DuckDBValue>)
      const r = await stmt.run()
      return normaliseRows(await r.getRowObjects())
    },

    async *stream(sql, params) {
      const hasParams = params && Object.keys(params).length > 0
      let r
      if (hasParams) {
        const stmt = await conn.prepare(sql)
        stmt.bind(params as Record<string, DuckDBValue>)
        r = await stmt.stream()
      }
      else {
        r = await conn.stream(sql)
      }
      const columnNames = r.columnNames()
      while (true) {
        const chunk = await r.fetchChunk()
        if (!chunk || chunk.rowCount === 0) break
        yield normaliseRows(chunk.getRowObjects(columnNames))
      }
    },

    createAppender(table) {
      // DuckDB appenders need to know (catalog, schema, table). Plain
      // names resolve against the default schema of the current catalog.
      // Iceberg-attached tables live in `<catalog>.<schema>.<table>`.
      // Callers that need iceberg-side inserts should use `execute()`
      // with INSERT statements; appenders here target local (`memory`)
      // tables only.
      const parts = table.split('.')
      const [catalog, schema, tbl] =
        parts.length === 3 ? parts
        : parts.length === 2 ? ['memory', parts[0], parts[1]]
        : ['memory', 'main', parts[0]]
      // Bridge sync seam → async @duckdb/node-api API by calling the
      // underlying sync bindings call directly. See file header.
      const rawConn = (conn as unknown as { connection: bindings.Connection }).connection
      const rawAppender = bindings.appender_create_ext(rawConn, catalog, schema, tbl)
      const app = new NodeAppender(conn, rawAppender)
      return wrapAppender(app)
    },

    async close() {
      conn.closeSync()
      inst.closeSync()
    },
  }
}

/**
 * Normalise DuckDB-node result values into JS primitives so tests can
 * assert with `toEqual` / `toBe`.
 *
 * The library returns:
 * - `BigInt` for BIGINT/HUGEINT (kept as-is for lossless comparison)
 * - `DuckDBTimestampValue` for TIMESTAMP — convert to ISO string
 *   (integration tests assert on wall-clock semantics, not micros)
 * - primitives for everything else
 */
function normaliseRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      if (v instanceof DuckDBTimestampValue) {
        // micros → ms → ISO string
        const ms = Number(v.micros / 1000n)
        out[k] = new Date(ms).toISOString()
      }
      else {
        out[k] = v
      }
    }
    return out
  })
}

/** JS-type-dispatching appender over the typed `@duckdb/node-api` surface. */
function wrapAppender(app: NodeAppender): DuckDBAppender {
  return {
    appendRow(values) {
      for (const v of values) appendValue(app, v)
      app.endRow()
    },
    flush() {
      app.flushSync()
    },
    close() {
      app.closeSync()
    },
  }
}

function appendValue(app: NodeAppender, v: unknown): void {
  if (v === null || v === undefined) {
    app.appendNull()
    return
  }
  switch (typeof v) {
    case 'boolean':
      app.appendBoolean(v)
      return
    case 'string':
      app.appendVarchar(v)
      return
    case 'number':
      if (Number.isInteger(v)) app.appendInteger(v)
      else app.appendDouble(v)
      return
    case 'bigint':
      app.appendBigInt(v)
      return
    case 'object':
      if (v instanceof Date) {
        app.appendTimestamp(new DuckDBTimestampValue(BigInt(v.getTime()) * 1000n))
        return
      }
      throw new Error(`appendValue: unsupported object type ${v?.constructor?.name}`)
    default:
      throw new Error(`appendValue: unsupported primitive type ${typeof v}`)
  }
}
