/**
 * Registry primitives — defineQuery / defineMutation / defineEvent.
 *
 * The Define API is entirely local: no engine access, no React, no
 * dispatcher. It hands back typed, discriminated handles that the
 * dispatcher (arriving in a later task) can safely inspect and route.
 *
 * See data-access/spec.md §Define API.
 */

import { DataAccessError } from './errors'
import type {
  DuckdbQueryConfig,
  EventDefinition,
  MutationConfig,
  MutationDefinition,
  QueryConfig,
  QueryDefinition,
} from './types'

/**
 * Register a typed query. Runtime enforces the engine-specific required
 * field so JS callers get a loud error even when TypeScript is skipped.
 *
 * DuckDB queries additionally run the JOIN-invalidation validator (T-37,
 * principle 48) — a console.warn advisory, never a throw.
 */
export function defineQuery<TInput, TOutput>(
  config: QueryConfig<TInput, TOutput>
): QueryDefinition<TInput, TOutput> {
  assertQueryEngineField(config)
  if (config.engine === 'duckdb') {
    validateJoinInvalidation(config)
  }
  return { __kind: 'query', config }
}

/**
 * Register a typed mutation. `exec` is required; `invalidates` patterns
 * fire through the invalidation bus on success.
 */
export function defineMutation<TInput, TOutput>(
  config: MutationConfig<TInput, TOutput>
): MutationDefinition<TInput, TOutput> {
  if (typeof config.exec !== 'function') {
    throw new DataAccessError(
      'define_config_invalid',
      'defineMutation requires an `exec` function'
    )
  }
  return { __kind: 'mutation', config }
}

/**
 * Register a typed event. Payload type is inferred at the point of use
 * (via useAppEvent). No runtime state is captured here.
 */
export function defineEvent<TPayload>(): EventDefinition<TPayload> {
  return { __kind: 'event' }
}

/**
 * T-34 — effective asyncFetch resolution (principle 57).
 *
 * Explicit `config.asyncFetch` wins outright. Otherwise inferred true
 * when the provider supplies `brandRetentionDays` and the caller's
 * `input.days` is numeric and exceeds it. Without a retention horizon,
 * asyncFetch is never inferred.
 */
export function resolveAsyncFetch(
  config: { asyncFetch?: boolean },
  input: unknown,
  brandRetentionDays: number | undefined
): boolean {
  if (typeof config.asyncFetch === 'boolean') return config.asyncFetch
  if (typeof brandRetentionDays !== 'number') return false
  const days = extractInputDays(input)
  return typeof days === 'number' && days > brandRetentionDays
}

/**
 * Pull a numeric `days` field off an arbitrary query input, if present.
 * Shared by resolveAsyncFetch and the hook's fetchOnDemand request.
 */
export function extractInputDays(input: unknown): number | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const days = (input as Record<string, unknown>).days
  return typeof days === 'number' && Number.isFinite(days) ? days : undefined
}

/**
 * Schema qualifiers whose relations are engine internals, never app
 * tables — schema-qualified references under these are ignored by the
 * JOIN-invalidation scan.
 */
const INTERNAL_SCHEMAS = new Set([
  'information_schema',
  'pg_catalog',
  'duckdb_catalog',
  'system',
  'temp',
])

/**
 * T-37 — scan a DuckDB SQL string for referenced base tables.
 *
 * Heuristic, not a SQL parser:
 *   - comments stripped, then identifiers captured after FROM / JOIN
 *   - CTE names (`WITH x AS (`, `x(cols) AS (`) collected first + excluded
 *   - set-returning function calls (`FROM generate_series(...)`) excluded
 *   - schema-qualified internals (information_schema.*) excluded
 *   - the union-view `v_` prefix is stripped (v_spo2 → spo2) so names
 *     line up with invalidation event segments
 */
export function extractReferencedTables(sql: string): string[] {
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')

  const cteNames = new Set<string>()
  const cteRe = /\b([a-zA-Z_]\w*)\s*(?:\([^()]*\))?\s+AS\s*\(/gi
  for (let m = cteRe.exec(stripped); m !== null; m = cteRe.exec(stripped)) {
    cteNames.add(m[1].toLowerCase())
  }

  const tables = new Set<string>()
  const refRe = /\b(?:FROM|JOIN)\s+([a-zA-Z_][\w.]*)/gi
  for (let m = refRe.exec(stripped); m !== null; m = refRe.exec(stripped)) {
    // `FROM fn(...)` is a function call, not a table. (`FROM (subquery)`
    // and `extract('minute' FROM (expr))` never match — "(" fails the
    // identifier pattern.)
    const rest = stripped.slice(m.index + m[0].length)
    if (/^\s*\(/.test(rest)) continue

    let name = m[1].toLowerCase()
    if (name.includes('.')) {
      const segments = name.split('.')
      if (INTERNAL_SCHEMAS.has(segments[0])) continue
      name = segments[segments.length - 1]
    }
    if (cteNames.has(name)) continue
    tables.add(name.replace(/^v_/, ''))
  }
  return [...tables]
}

/**
 * T-37 — JOIN invalidation validator (principle 48).
 *
 * A table T is covered when any `invalidatedBy` entry's first
 * colon-segment equals T, or equals `batch` (batch:complete implies all
 * tables in the batch flushed). Advisory only: multi-table SQL with an
 * uncovered table warns via console.warn; it never throws. Single-table
 * (or table-free) SQL is always silent.
 */
function validateJoinInvalidation<TInput, TOutput>(
  config: DuckdbQueryConfig<TInput, TOutput>
): void {
  const tables = extractReferencedTables(config.sql)
  if (tables.length < 2) return

  const covered = new Set(
    (config.invalidatedBy ?? []).map((entry) => entry.split(':')[0])
  )
  if (covered.has('batch')) return

  const missing = tables.filter((table) => !covered.has(table))
  if (missing.length === 0) return

  const snippet = config.sql.replace(/\s+/g, ' ').trim().slice(0, 80)
  console.warn(
    `[@mongrov/data-access] defineQuery: SQL references tables ` +
      `[${tables.join(', ')}] but invalidatedBy does not cover ` +
      `[${missing.join(', ')}]. JOIN-dependent queries must invalidate ` +
      `on all joined tables (principle 48). sql: "${snippet}"`
  )
}

function assertQueryEngineField<TInput, TOutput>(
  config: QueryConfig<TInput, TOutput>
): void {
  switch (config.engine) {
    case 'duckdb':
      if (typeof config.sql !== 'string' || config.sql.length === 0) {
        throw new DataAccessError(
          'define_config_invalid',
          "defineQuery: engine 'duckdb' requires a non-empty `sql` string"
        )
      }
      return
    case 'rxdb':
      if (typeof config.query !== 'function') {
        throw new DataAccessError(
          'define_config_invalid',
          "defineQuery: engine 'rxdb' requires a `query` function"
        )
      }
      return
    case 'kv':
      if (typeof config.keyBuilder !== 'function') {
        throw new DataAccessError(
          'define_config_invalid',
          "defineQuery: engine 'kv' requires a `keyBuilder` function"
        )
      }
      return
    default: {
      // Exhaustiveness: if a new engine is added, TS surfaces this at compile time.
      const exhaustive: never = config
      throw new DataAccessError(
        'define_config_invalid',
        `defineQuery: unknown engine ${JSON.stringify(exhaustive)}`
      )
    }
  }
}
