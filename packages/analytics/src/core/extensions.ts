/**
 * DuckDB extension bootstrap.
 *
 * Two extension sets, selected by mode:
 * - `r2` (default) — `httpfs` + `iceberg` + `parquet`. Required before
 *   any `ATTACH 'iceberg://…'` can succeed. iceberg + httpfs also drag
 *   in AWSSDK + OpenSSL/curl at native build time — see the fork's
 *   build-duckdb-ios.sh / android/CMakeLists.txt for the vcpkg wiring.
 * - `local` — just `parquet`. Skips iceberg + httpfs entirely, which
 *   means local-only consumers can build the fork WITHOUT AWSSDK /
 *   OpenSSL / vcpkg (major DX win on iOS + Android).
 *
 * This module is the single place we issue `INSTALL/LOAD`, so failures
 * map cleanly to `AnalyticsError('extension_load_failed', <name>)`.
 *
 * Bootstrapping is idempotent — a `#booted: Set<string>` guards repeated
 * calls, and DuckDB itself no-ops re-loads, so calling twice is safe.
 */

import { AnalyticsError } from './errors'
import type { HybridDuckDB } from './engine'
import type { AnalyticsMode } from './types'

/**
 * Extensions required for R2 Iceberg attach, in load order.
 *
 * `icu` sits between `httpfs` and `iceberg` per Sprint 5 T-01. It is not
 * optional: every registry query and every baseline computation groups by
 * local day via `timezone($tz, ts)` / `date_trunc('day', timezone(...))`,
 * and DuckDB's `timezone()` with a named IANA zone resolves only when
 * `icu` is loaded. Without it those queries fail at parse time rather than
 * silently returning UTC-grouped rows.
 */
export const REQUIRED_EXTENSIONS = ['httpfs', 'icu', 'iceberg', 'parquet'] as const

/**
 * Extensions required for local-only mode (no remote sync, no iceberg).
 *
 * `icu` is here too, and deliberately so: local mode skips `httpfs` +
 * `iceberg` to avoid the AWSSDK/vcpkg build burden, but it does NOT skip
 * timezone-aware queries — a local-only install still renders day charts
 * and computes day-first baselines. Omitting `icu` here would make those
 * paths work on R2 installs and fail on local ones.
 */
export const LOCAL_EXTENSIONS = ['icu', 'parquet'] as const

export type RequiredExtension = (typeof REQUIRED_EXTENSIONS)[number]

/**
 * Tracks which extensions this process has already booted. Keyed by
 * `HybridDuckDB` instance to keep isolation across engines in tests.
 */
const bootedByDb = new WeakMap<HybridDuckDB, Set<string>>()

/**
 * Issue `INSTALL <ext>; LOAD <ext>;` for each mode-appropriate extension
 * in order.
 *
 * `mode` is optional and defaults to `'r2'` for back-compat with 0.4.x
 * callers.
 *
 * Idempotent per-engine: extensions already loaded on the same
 * `HybridDuckDB` instance are skipped.
 *
 * @throws `AnalyticsError('extension_load_failed', <ext>)` if any extension
 *   fails; the extension name appears in the message + cause is preserved.
 */
export async function bootstrapExtensions(
  db: HybridDuckDB,
  mode: AnalyticsMode = 'r2',
): Promise<void> {
  let booted = bootedByDb.get(db)
  if (!booted) {
    booted = new Set()
    bootedByDb.set(db, booted)
  }

  const extensions: readonly string[]
    = mode === 'local' ? LOCAL_EXTENSIONS : REQUIRED_EXTENSIONS

  for (const ext of extensions) {
    if (booted.has(ext)) {
      continue
    }
    // LOAD first, INSTALL only as a fallback.
    //
    // A statically linked extension needs no INSTALL, and on mobile the
    // INSTALL cannot succeed: there is no artifact to fetch. iOS asks for
    // `http://extensions.duckdb.org/<ver>/ios_arm64/<ext>.duckdb_extension.gz`
    // and gets a 404, so issuing INSTALL unconditionally made a correctly
    // built binary fail exactly as loudly as a missing one.
    //
    // Ordering it this way keeps both cases working: linked extensions load
    // straight away, and a desktop build that genuinely needs a download
    // still gets one from the fallback.
    try {
      await db.execute(`LOAD ${ext};`)
    }
    catch (loadCause) {
      try {
        await db.execute(`INSTALL ${ext};`)
        await db.execute(`LOAD ${ext};`)
      }
      catch {
        // Report the original LOAD failure: if the extension is meant to be
        // linked in, "could not load" is the real problem and the INSTALL
        // 404 is just noise about a fetch that was never going to work.
        throw new AnalyticsError(
          'extension_load_failed',
          `Failed to load DuckDB extension: ${ext}`,
          loadCause,
        )
      }
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
