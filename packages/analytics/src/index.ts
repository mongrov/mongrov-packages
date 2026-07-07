/**
 * @mongrov/analytics — DuckDB + R2 Iceberg local analytics
 *
 * Root subpath re-exports the core surface. Subpaths:
 *   - @mongrov/analytics         → core (engine, factory, hooks)
 *   - @mongrov/analytics/rules   → structured threshold rule engine
 *   - @mongrov/analytics/tools   → typed AI SDK tools + MCP server
 *   - @mongrov/analytics/sync    → firmware mapper + sensor sink + R2 push/fetch
 *   - @mongrov/analytics/ui      → UI primitives (subpath reserved)
 *
 * See `.specifica/features/analytics-core/spec.md` for scope.
 */

export * from './core'
