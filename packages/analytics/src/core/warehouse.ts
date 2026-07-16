/**
 * Warehouse attach / detach for a single tenant zone.
 *
 * Attaches R2 Iceberg data as a named DuckDB catalog, so downstream code can
 * `SELECT ... FROM zone_<tenantId>.<table>`. The full sequence lives here so
 * the state machine (T-09) can invoke it as a single actor step.
 *
 * Sequence per spec §Attach Protocol:
 *   1. Build warehouse URI via `warehouseUriBuilder(brand, scope, tenantId)`.
 *   2. Fetch bearer token via `tokenVendor.fetch({ brand, scope, tenantId })`.
 *   3. `CREATE OR REPLACE SECRET` bound to the catalog endpoint + bearer token.
 *   4. `ATTACH '<warehouseUri>' AS zone_<tenantId> (TYPE ICEBERG)`.
 *   5. If `tenantScope === 'family'`, prime member ids via
 *      `familyMembersProvider({ brand, familyId })` (for retention math).
 *
 * All failures map to `AnalyticsError('attach_failed' | 'token_vendor_failed',
 * <phase>, cause)`.
 */

import { AnalyticsError } from './errors'
import type { HybridDuckDB } from './engine'
import type {
  AttachContext,
  FamilyMembersProvider,
  TenantScope,
  TokenResponse,
  TokenVendor,
} from './types'

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
export function warehouseSecretName(tenantId: string): string {
  return `zone_${tenantId.replace(/[^A-Za-z0-9_]/g, '_')}`
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

  // Step 4: ATTACH + pin the current schema to the `default` namespace.
  //
  // DuckDB's Iceberg attach does not select a namespace, so unqualified
  // `<catalog>.<table>` DDL (see `schemas.ts` / `qualifyDdl`) would resolve
  // against schema `""` and fail with `Schema with name "" not found`.
  // Iceberg mandates 3-part names; picking `default` here lets the rest of
  // the codebase keep the 2-part `<catalog>.<table>` shape it was written
  // against. Callers that need a different namespace should attach directly.
  try {
    await db.execute(
      `ATTACH '${uri}' AS ${secretName} (TYPE ICEBERG);`,
    )
    await db.execute(`USE ${secretName}.default;`)
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
 */
export async function detachWarehouse(
  db: HybridDuckDB,
  tenantId: string,
): Promise<void> {
  const secretName = warehouseSecretName(tenantId)
  try {
    // DuckDB refuses to detach the current default database, and `attach`
    // above pinned it to `${secretName}.default`. Reset to the in-memory
    // catalog before detaching so DETACH succeeds.
    await db.execute(`USE memory.main;`)
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
