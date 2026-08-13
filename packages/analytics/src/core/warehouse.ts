/**
 * Warehouse attach / detach.
 *
 * Two modes:
 * - `attachWarehouse` (R2 mode): attaches R2 Iceberg data as a named
 *   DuckDB catalog, so downstream code can address remote tables via
 *   `<zone_<tenantId>>.default.<table>` (3-part names).
 * - `attachLocal` (local mode): no ATTACH; local tables live in the
 *   current file-backed catalog. Returns a synthetic `AttachResult`
 *   whose `warehouseSecret` is the local catalog name (probed via
 *   `current_database()`), so downstream state-machine code keeps the
 *   same shape.
 *
 * Sequence for `attachWarehouse` per spec §Attach Protocol:
 *   1. Build warehouse URI via `warehouseUriBuilder(brand, scope, tenantId)`.
 *   2. Fetch bearer token via `tokenVendor.fetch({ brand, scope, tenantId })`.
 *   3. `CREATE OR REPLACE SECRET` bound to the catalog endpoint + bearer token.
 *   4. `ATTACH '<warehouseUri>' AS zone_<tenantId> (TYPE ICEBERG)`.
 *   5. If `tenantScope === 'family'`, prime member ids via
 *      `familyMembersProvider({ brand, familyId })` (for retention math).
 *
 * NOTE: 0.5.0 dropped the previous `USE ${secretName}.default` step
 * inside attach + the matching `USE memory.main` before detach. Rationale:
 * `USE memory.main` fails on file-backed DuckDB (real devices open a
 * `.duckdb` file → catalog name is the file stem, not `memory`), and the
 * `USE remote` step made unqualified queries resolve to the remote
 * catalog — silently breaking the pusher's `main.<table>` SQL by pointing
 * `main` at the remote instead of local. Callers should address remote
 * tables via 3-part names (`<secret>.default.<table>`); local tables stay
 * addressable via unqualified names.
 *
 * All failures map to `AnalyticsError('attach_failed' | 'token_vendor_failed',
 * <phase>, cause)`.
 */

import type { HybridDuckDB } from './engine'
import type {
  AttachContext,
  FamilyMembersProvider,
  TenantScope,
  TokenResponse,
  TokenVendor,
} from './types'
import { AnalyticsError } from './errors'
import { dropViewDdl, generateViewDdl, VIEWED_TABLES } from './schemas'

/**
 * Peel one layer of `AnalyticsError('query_failed')` off engine-wrapped
 * errors so the outer `attach_failed` error's `cause` chain surfaces the
 * root native failure, not our own intermediate wrap.
 */
function rootCause(err: unknown): unknown {
  if (err instanceof AnalyticsError && err.code === 'query_failed') {
    return err.cause ?? err
  }
  return err
}

/** Dependencies required to attach a warehouse — a subset of `AnalyticsConfig`. */
export interface AttachDeps {
  warehouseUriBuilder: (
    brand: string,
    tenantScope: TenantScope,
    tenantId: string,
  ) => string
  tokenVendor: TokenVendor
  familyMembersProvider: FamilyMembersProvider
  catalogEndpoint: string
}

/** Result of a successful attach — surfaced to the machine + config store. */
export interface AttachResult {
  /** DuckDB secret + catalog alias, e.g. `zone_fam123`. */
  warehouseSecret: string
  /** S3/Iceberg URI the warehouse points at. */
  warehouseUri: string
  /** When the bearer token expires (drives 75% TTL refresh in T-09). */
  tokenExpiresAt: Date
  /** Populated only when `tenantScope === 'family'`. */
  familyMemberIds?: string[]
}

/**
 * Derive the DuckDB catalog alias for a tenant. Also used as the SECRET name.
 *
 * Sanitised to `[A-Za-z0-9_]` so it's always a valid DuckDB identifier.
 */
const NON_WORD_RE = /\W/g

export function warehouseSecretName(tenantId: string): string {
  return `zone_${tenantId.replace(NON_WORD_RE, '_')}`
}

/**
 * Attach a warehouse for a single tenant zone.
 *
 * Steps are surfaced explicitly in the error message so callers (machine,
 * logger) can see which phase failed.
 */
export async function attachWarehouse(
  db: HybridDuckDB,
  ctx: AttachContext,
  deps: AttachDeps,
): Promise<AttachResult> {
  const secretName = warehouseSecretName(ctx.tenantId)

  // Step 1: warehouse URI
  let uri: string
  try {
    uri = deps.warehouseUriBuilder(ctx.brand, ctx.tenantScope, ctx.tenantId)
  }
  catch (cause) {
    throw new AnalyticsError(
      'attach_failed',
      `warehouseUriBuilder failed for ${ctx.tenantId}`,
      cause,
    )
  }

  // Step 2: bearer token
  let token: TokenResponse
  try {
    token = await deps.tokenVendor.fetch({
      brand: ctx.brand,
      tenantScope: ctx.tenantScope,
      tenantId: ctx.tenantId,
    })
  }
  catch (cause) {
    throw new AnalyticsError(
      'token_vendor_failed',
      `tokenVendor.fetch failed for ${ctx.tenantId}`,
      cause,
    )
  }

  // Step 3: CREATE OR REPLACE SECRET
  try {
    await db.execute(
      `CREATE OR REPLACE SECRET ${secretName} (TYPE ICEBERG, TOKEN $token, ENDPOINT $endpoint);`,
      { token: token.token, endpoint: deps.catalogEndpoint },
    )
  }
  catch (cause) {
    throw new AnalyticsError(
      'attach_failed',
      `CREATE SECRET failed for ${secretName}`,
      rootCause(cause),
    )
  }

  // Step 4: ATTACH. See top-of-file NOTE for why the prior
  // `USE ${secretName}.default` step was dropped in 0.5.0. Consumers write
  // to the remote via 3-part names (`${secretName}.default.<table>`), keeping
  // local `main.<table>` addressable for the pusher's SELECT source and the
  // rules engine's INSERT sink.
  try {
    await db.execute(
      `ATTACH '${uri}' AS ${secretName} (TYPE ICEBERG);`,
    )
  }
  catch (cause) {
    throw new AnalyticsError(
      'attach_failed',
      `ATTACH failed for ${secretName}`,
      rootCause(cause),
    )
  }

  // Step 5: prime family members (retention math in T-14)
  let familyMemberIds: string[] | undefined
  if (ctx.tenantScope === 'family') {
    try {
      familyMemberIds = await deps.familyMembersProvider({
        brand: ctx.brand,
        familyId: ctx.tenantId,
      })
    }
    catch (cause) {
      throw new AnalyticsError(
        'attach_failed',
        `familyMembersProvider failed for ${ctx.tenantId}`,
        cause,
      )
    }
  }

  return {
    warehouseSecret: secretName,
    warehouseUri: uri,
    tokenExpiresAt: token.expiresAt,
    familyMemberIds,
  }
}

/**
 * Reverse of `attachWarehouse`: `DETACH` the catalog then drop its secret.
 * Idempotent from the caller's perspective — a `DETACH` of an unknown alias
 * throws in DuckDB, but the machine only calls this from `attached`.
 *
 * Since 0.5.0's attach no longer switches the current catalog with
 * `USE ${secretName}.default`, this detach no longer needs to reset via
 * `USE memory.main` (which failed on file-backed DuckDB anyway — the
 * catalog on a real device is `<filestem>`, not `memory`).
 */
export async function detachWarehouse(
  db: HybridDuckDB,
  tenantId: string,
): Promise<void> {
  const secretName = warehouseSecretName(tenantId)
  try {
    await db.execute(`DETACH ${secretName};`)
    await db.execute(`DROP SECRET ${secretName};`)
  }
  catch (cause) {
    throw new AnalyticsError(
      'detach_failed',
      `detach failed for ${secretName}`,
      rootCause(cause),
    )
  }
}

// -------------------- local mode --------------------

/**
 * Local-mode "attach" — no ATTACH statement, no auth, no remote catalog.
 * The consumer's DuckDB (in-memory or file-backed) is already the current
 * catalog after `db.open()`; we just probe its name and return a synthetic
 * `AttachResult`. Table creation is deferred to `ensureMigrations` (called
 * next by the factory) so schema evolution stays in one place.
 *
 * `warehouseSecret` in the returned result is set to the local catalog
 * name (from `current_database()`) so downstream state-machine code + the
 * public `engine.catalog` getter surface a meaningful identifier. Fields
 * that only make sense for R2 (`warehouseUri`, `tokenExpiresAt`) get
 * sentinel values: URI is `local:`, expiry is far-future so token-refresh
 * timers never fire.
 */
export async function attachLocal(
  db: HybridDuckDB,
  _ctx: AttachContext,
): Promise<AttachResult> {
  // Probe the current catalog name so downstream code addresses local
  // tables via `${catalog}.main.<table>` when it needs to be explicit.
  let catalog: string
  try {
    catalog = await probeCatalogName(db)
  }
  catch (cause) {
    throw new AnalyticsError(
      'attach_failed',
      `attachLocal: could not determine the current catalog`,
      rootCause(cause),
    )
  }

  // Sentinel expiry — 100 years from now. Token-refresh scheduling in the
  // state machine keys off this; setting it far-future prevents the
  // refresh actor from ever firing in local mode.
  const farFuture = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000)

  return {
    warehouseSecret: catalog,
    warehouseUri: 'local:',
    tokenExpiresAt: farFuture,
    // No family fanout in local mode; retention math falls back to ctx.userId.
    familyMemberIds: undefined,
  }
}

/**
 * Probe the current DuckDB catalog name (via `SELECT current_database()`).
 * Used by R2 mode too — the pusher needs to know the local catalog name so
 * its `INSERT INTO r2.default.<table> SELECT * FROM <local>.main.<table>`
 * addresses the correct source (post-0.5.0 attach no longer switches the
 * current catalog, so `main.<table>` still means local).
 */
/**
 * Current catalog name, probed defensively.
 *
 * `SELECT current_database()` is the obvious query and works on desktop
 * DuckDB, but it is not universally safe: the react-native-duckdb iOS build
 * rejects it with `Binder Error: Referenced table "system" not found!`,
 * which took down attach before a single table was touched.
 *
 * So try the scalar function, then `PRAGMA database_list` (which reports the
 * attached databases directly and does not depend on function binding), and
 * only give up if both fail. The name matters because local tables are
 * addressed as `${catalog}.main.<table>` when qualification is needed.
 */
async function probeCatalogName(db: HybridDuckDB): Promise<string> {
  const attempts: (() => Promise<string | undefined>)[] = [
    async () => {
      const rows = await db.execute<{ current_database: string }>(
        `SELECT current_database() AS current_database;`,
      )
      return rows[0]?.current_database
    },
    async () => {
      // seq/name/file; the first non-temp entry is the main catalog.
      const rows = await db.execute<{ name?: string, database_name?: string }>(
        `PRAGMA database_list;`,
      )
      const row = rows.find(r => (r.name ?? r.database_name) !== 'temp')
      return row?.name ?? row?.database_name
    },
  ]

  let lastCause: unknown
  for (const attempt of attempts) {
    try {
      const name = await attempt()
      if (name)
        return name
    }
    catch (cause) {
      lastCause = cause
    }
  }
  if (lastCause !== undefined)
    throw lastCause
  return 'memory'
}

export async function probeLocalCatalog(db: HybridDuckDB): Promise<string> {
  try {
    return await probeCatalogName(db)
  }
  catch (cause) {
    throw new AnalyticsError(
      'query_failed',
      `probeLocalCatalog: could not determine the current catalog`,
      rootCause(cause),
    )
  }
}

/**
 * Reverse of `attachLocal` — no-op. Local mode never issued any ATTACH /
 * SECRET, so there's nothing to unwind. Kept as an explicit function so
 * the state machine's `detachEngine` actor can dispatch symmetrically.
 */
export async function detachLocal(
  _db: HybridDuckDB,
  _tenantId: string,
): Promise<void> {
  // intentional no-op
}

// -------------------- union views (Sprint 5 T-06) --------------------

/**
 * Create every `v_{table}` union view for the current attach.
 *
 * Called after migrations, so the underlying tables are guaranteed to
 * exist — a view over a missing table fails at creation in DuckDB, not
 * lazily at scan.
 *
 * The view bodies bake in `brand` + `family_id` (see `generateViewDdl` for
 * why they cannot be bound parameters), which makes recreation on every
 * attach a correctness requirement rather than housekeeping: a brand
 * switch that reused the previous attach's views would serve the previous
 * tenant's rows. `CREATE OR REPLACE` handles the overwrite; `dropViews` on
 * detach closes the window where a stale view exists with no attach behind
 * it.
 */
export async function createViews(
  db: HybridDuckDB,
  ctx: {
    brand: string
    familyId: string
    localCatalog: string
    remoteCatalog?: string
  },
): Promise<void> {
  for (const table of VIEWED_TABLES) {
    try {
      await db.execute(generateViewDdl(table, ctx))
    }
    catch (cause) {
      throw new AnalyticsError(
        'attach_failed',
        `CREATE VIEW v_${table} failed`,
        rootCause(cause),
      )
    }
  }
}

/**
 * Drop every union view. Idempotent (`DROP VIEW IF EXISTS`), and tolerant
 * of individual failures: detach must not be blockable by a view that is
 * already gone or whose catalog vanished first, or the engine would strand
 * in `detaching`.
 */
export async function dropViews(db: HybridDuckDB): Promise<void> {
  for (const table of VIEWED_TABLES) {
    try {
      await db.execute(dropViewDdl(table))
    }
    catch {
      // Best-effort: a failed DROP VIEW IF EXISTS means the catalog is
      // already unreachable, which is the state we were aiming for.
    }
  }
}
