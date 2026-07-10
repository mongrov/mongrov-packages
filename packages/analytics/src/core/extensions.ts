/**
 * DuckDB extension bootstrap.
 *
 * Analytics needs `httpfs` + `iceberg` + `parquet` loaded before any
 * `ATTACH 'iceberg://…'` can succeed. This module is the single place we
 * issue `INSTALL/LOAD`, so failures map cleanly to
 * `AnalyticsError('extension_load_failed', <name>)`.
 *
 * Bootstrapping is idempotent — a `#booted: Set<string>` guards repeated
 * calls, and DuckDB itself no-ops re-loads, so calling twice is safe.
 */

import { AnalyticsError } from './errors'
import type { HybridDuckDB } from './engine'

/** Extensions required for R2 Iceberg attach, in load order. */
export const REQUIRED_EXTENSIONS = ['httpfs', 'iceberg', 'parquet'] as const

export type RequiredExtension = (typeof REQUIRED_EXTENSIONS)[number]

/**
 * Tracks which extensions this process has already booted. Keyed by
 * `HybridDuckDB` instance to keep isolation across engines in tests.
 */
const bootedByDb = new WeakMap<HybridDuckDB, Set<string>>()

/**
 * Issue `INSTALL <ext>; LOAD <ext>;` for each required extension in order.
 *
 * Idempotent per-engine: extensions already loaded on the same
 * `HybridDuckDB` instance are skipped.
 *
 * @throws `AnalyticsError('extension_load_failed', <ext>)` if any extension
 *   fails; the extension name appears in the message + cause is preserved.
 */
export async function bootstrapExtensions(db: HybridDuckDB): Promise<void> {
  let booted = bootedByDb.get(db)
  if (!booted) {
    booted = new Set()
    bootedByDb.set(db, booted)
  }

  for (const ext of REQUIRED_EXTENSIONS) {
    if (booted.has(ext)) {
      continue
    }
    try {
      await db.execute(`INSTALL ${ext};`)
      await db.execute(`LOAD ${ext};`)
    }
    catch (cause) {
      throw new AnalyticsError(
        'extension_load_failed',
        `Failed to load DuckDB extension: ${ext}`,
        cause,
      )
    }
    booted.add(ext)
  }
}

/**
 * Test-only: introspect which extensions have been booted for a given engine.
 *
 * Exposed for coverage of the idempotency path in
 * `__tests__/extensions.test.ts`; not re-exported from `core/index.ts`.
 */
export function getBootedExtensions(db: HybridDuckDB): ReadonlySet<string> {
  return bootedByDb.get(db) ?? new Set()
}
