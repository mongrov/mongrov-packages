/**
 * @mongrov/analytics — DuckDB + R2 Iceberg local analytics
 *
 * Root subpath re-exports the core surface. Subpaths:
 *   - @mongrov/analytics         → core (engine, factory, hooks)
 *   - @mongrov/analytics/rules   → structured threshold rule engine
 *   - @mongrov/analytics/tools   → typed AI SDK tools + MCP server
 *   - @mongrov/analytics/sync    → ingest adapters + sensor sink + R2 push/fetch
 *   - @mongrov/analytics/ui      → UI primitives (subpath reserved)
 *
 * The engine is domain-free: tables, ingest adapters, quality views,
 * post-flush jobs, baselines, metrics, rules and tools arrive in packs
 * (`definePack` / `registerPack`).
 */

export * from './core'
