/**
 * Wires config + engine + machine into an `AnalyticsEngine`.
 *
 * Public entry:  `createAnalytics(config)` — used by apps. Uses the injected
 * duckdb factory from `config.duckdb?.factory` (see below) or a lazy
 * `react-native-duckdb` resolver.
 *
 * The 2nd (optional) `internal` argument is an escape hatch for tests +
 * embed contexts that need to substitute a `DuckDBFactory` without shipping
 * `react-native-duckdb`. Not part of the spec surface; consumers should
 * stick to the 1-arg form.
 */

import type { DuckDBFactory, DuckDBInstance } from './engine'

import type { MachineActors } from './machine'
import type {
  AnalyticsAppender,
  AnalyticsConfig,
  AnalyticsEngine,
  AnalyticsState,
  AttachContext,
  R2AnalyticsConfig,
  Unsubscribe,
} from './types'
import { createActor } from 'xstate'
import { HybridDuckDB } from './engine'
import { AnalyticsError, describeError, NotImplementedError } from './errors'
import { bootstrapExtensions } from './extensions'
import { dismissInsight as dismissInsightImpl } from './insight'
import { resolveLogger } from './logger'
import { analyticsMachine } from './machine'
import { ensureMigrations } from './migrations'
import {
  clearLastAttach,
  loadLastAttach,
  loadRetentionOverride,
  saveLastAttach,
  saveRetentionOverride,
} from './persistence'
import { resolveEffectiveRetention, runRetentionSweep } from './retention'
import {
  attachLocal,
  attachWarehouse,
  createViews,
  detachLocal,
  detachWarehouse,
  dropViews,
  probeLocalCatalog,
  warehouseSecretName,
} from './warehouse'

// -------------------- default DuckDB factory --------------------

/**
 * Lazy resolver for `react-native-duckdb`. Only fires on `open()` — importing
 * `createAnalytics` on a Node/CI host without the native module must not
 * throw. Failure is deferred to the machine's `openEngine` actor, which
 * surfaces as `AnalyticsError('engine_open_failed')` per spec.
 */
function defaultDuckdbFactory(): DuckDBFactory {
  return async () => {
    throw new NotImplementedError(
      'defaultDuckdbFactory — supply internal.duckdbFactory or wait for react-native-duckdb adapter',
    )
    // T-10 acceptance: apps must supply a factory via the internal arg while
    // the react-native-duckdb adapter lands (tracked separately). Returning
    // an unreachable satisfies the `DuckDBInstance` return contract.
    return undefined as unknown as DuckDBInstance
  }
}

// -------------------- internal escape hatch --------------------

/**
 * Internal-only extra input for `createAnalytics`. Not exported from the
 * package barrel; ships in the `factory.ts` module surface so the test suite
 * and embedders can substitute a `DuckDBFactory` without shipping
 * `react-native-duckdb`.
 */
export interface CreateAnalyticsInternal {
  /** Substitute the DuckDB factory (fakes in tests; native adapter in app). */
  duckdbFactory?: DuckDBFactory
}

// -------------------- state promise helper --------------------

/**
 * Resolve when the actor next enters one of `targets` (excluding its
 * current* state at the time of subscription).
 */
function waitForNextState<S extends string>(
  actor: ReturnType<typeof createActor<typeof analyticsMachine>>,
  targets: readonly S[],
): Promise<S> {
  return new Promise((resolve) => {
    let seenFirst = false
    const targetSet = new Set<string>(targets)
    const sub = actor.subscribe((snapshot) => {
      if (!seenFirst) {
        seenFirst = true
        return
      }
      const value = typeof snapshot.value === 'string' ? snapshot.value : ''
      if (targetSet.has(value)) {
        sub.unsubscribe()
        resolve(value as S)
      }
    })
  })
}

function currentState(actor: ReturnType<typeof createActor<typeof analyticsMachine>>): AnalyticsState {
  const raw = actor.getSnapshot().value
  return typeof raw === 'string' ? (raw as AnalyticsState) : 'idle'
}

function assertAttached(state: AnalyticsState, operation: string): void {
  if (state !== 'attached') {
    throw new AnalyticsError(
      'not_attached',
      `${operation} requires an attached engine (state=${state})`,
    )
  }
}

const MEMORY_LIMIT_PATTERN = /^\d+(?:\.\d+)?\s*(?:KB|MB|GB|TB)$/i
const THREADS_PATTERN = /^\d+$/

async function applyDuckdbTuning(
  db: HybridDuckDB,
  cfg: AnalyticsConfig['duckdb'],
): Promise<void> {
  if (cfg?.memoryLimit !== undefined) {
    if (!MEMORY_LIMIT_PATTERN.test(cfg.memoryLimit)) {
      throw new AnalyticsError(
        'engine_open_failed',
        `invalid duckdb.memoryLimit: ${cfg.memoryLimit} (expected e.g. '512MB', '2GB')`,
      )
    }
    await db.execute(`SET memory_limit = '${cfg.memoryLimit}'`)
  }
  if (cfg?.threads !== undefined) {
    if (!THREADS_PATTERN.test(cfg.threads)) {
      throw new AnalyticsError(
        'engine_open_failed',
        `invalid duckdb.threads: ${cfg.threads} (expected integer)`,
      )
    }
    await db.execute(`SET threads = ${cfg.threads}`)
  }
}

// -------------------- factory --------------------

export function createAnalytics(
  config: AnalyticsConfig,
  internal: CreateAnalyticsInternal = {},
): AnalyticsEngine {
  const log = resolveLogger(config.logger)
  const duckdbFactory = internal.duckdbFactory ?? defaultDuckdbFactory()
  const db = new HybridDuckDB(duckdbFactory)

  // Resolve mode once — default 'r2' for back-compat with 0.4.x call sites
  // that don't set the field. `isLocal` gates dispatch throughout the
  // actor closures; `r2Config` is a typed alias for the R2 branch (safe
  // by construction — only accessed inside `if (!isLocal)` blocks).
  const mode = config.mode ?? 'r2'
  const isLocal = mode === 'local'
  const r2Config = config as R2AnalyticsConfig

  const machineActors: MachineActors = {
    async openEngine() {
      await db.open()
      await applyDuckdbTuning(db, config.duckdb)
      await bootstrapExtensions(db, mode)
    },
    async attachEngine({ ctx }) {
      // Dispatch based on mode. Local: probe current catalog, no auth,
      // no ATTACH. R2: full attach protocol (URI + token + SECRET + ATTACH).
      // In both cases, ensureMigrations runs with the appropriate catalog
      // set — LOCAL_SCHEMAS always in local catalog; SCHEMAS in remote
      // when attached — so local tables get created even for R2 installs
      // (fixing the pre-0.5.0 gap where the sink threw on first append).
      let attach
      let remoteCatalog: string | undefined
      if (isLocal) {
        attach = await attachLocal(db, ctx)
      }
      else {
        attach = await attachWarehouse(db, ctx, {
          warehouseUriBuilder: r2Config.warehouseUriBuilder,
          tokenVendor: r2Config.tokenVendor,
          familyMembersProvider: r2Config.familyMembersProvider,
          catalogEndpoint: r2Config.catalogEndpoint,
        })
        remoteCatalog = attach.warehouseSecret
      }

      const localCatalog = await probeLocalCatalog(db)
      localCatalogName = localCatalog

      await ensureMigrations(
        db,
        config.storage,
        { brand: ctx.brand, tenantId: ctx.tenantId },
        { local: localCatalog, remote: remoteCatalog },
      )

      // Union views last — they read the tables migrations just ensured,
      // and DuckDB validates a view's body at CREATE time, so this must
      // not run before the schema exists. View bodies inline brand +
      // family_id (see generateViewDdl), which is why they are recreated
      // on every attach rather than created once: a brand switch that
      // reused the previous views would serve the previous tenant's rows.
      await createViews(db, {
        brand: ctx.brand,
        familyId: ctx.tenantId,
        localCatalog,
        remoteCatalog,
      })
      return {
        warehouseSecret: attach.warehouseSecret,
        tokenExpiresAt: attach.tokenExpiresAt.getTime(),
      }
    },
    async detachEngine({ ctx }) {
      // Views first: they reference the remote catalog, so dropping them
      // after DETACH would leave definitions pointing at a catalog that no
      // longer exists. Best-effort inside dropViews, so a failure here can
      // never strand the machine in `detaching`.
      await dropViews(db)
      if (isLocal) {
        await detachLocal(db, ctx.tenantId)
      }
      else {
        await detachWarehouse(db, ctx.tenantId)
      }
    },
    async refreshToken({ ctx }) {
      // Local mode: no token, no refresh. Return a far-future expiry so
      // the machine's TOKEN_REFRESH_TICK never fires again. This actor
      // shouldn't be scheduled in local mode (attachLocal returns
      // sentinel far-future expiry), but guarding here is cheap
      // defense-in-depth if a consumer forces attachEngine somehow.
      if (isLocal) {
        return {
          tokenExpiresAt: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
        }
      }
      const token = await r2Config.tokenVendor.fetch({
        brand: ctx.brand,
        tenantScope: ctx.tenantScope,
        tenantId: ctx.tenantId,
      })
      const secretName = warehouseSecretName(ctx.tenantId)
      try {
        await db.execute(
          `CREATE OR REPLACE SECRET ${secretName} (TYPE ICEBERG, TOKEN $token, ENDPOINT $endpoint);`,
          { token: token.token, endpoint: r2Config.catalogEndpoint },
        )
      }
      catch (cause) {
        throw new AnalyticsError(
          'token_vendor_failed',
          `refreshToken: CREATE OR REPLACE SECRET failed for ${secretName}`,
          cause,
        )
      }
      return { tokenExpiresAt: token.expiresAt.getTime() }
    },
  }

  const actor = createActor(analyticsMachine, { input: { deps: machineActors } })

  const publicSubscribers = new Set<(s: AnalyticsState) => void>()
  let lastLoggedState: AnalyticsState | undefined
  const internalSub = actor.subscribe(() => {
    const s = currentState(actor)
    if (s !== lastLoggedState) {
      lastLoggedState = s
      log.debug('analytics.state', { value: s })
    }
    for (const fn of publicSubscribers) fn(s)
  })

  actor.start()
  actor.send({ type: 'OPEN' })

  /**
   * Ctx of the last successful attach; cleared on detach. Used by
   * `setRetention` (needs `brand/tenantId/userId` for the override key) and
   * by the attach-time persistence + sweep hook.
   */
  let currentCtx: AttachContext | undefined

  /**
   * Local DuckDB catalog name, probed during attach. The retention sweep
   * targets this catalog in BOTH modes — device-side compaction prunes
   * local data only; the remote R2 zone is never swept by the client
   * (principles 17/53 — server-side retention is R2 snapshot expiration).
   */
  let localCatalogName: string | undefined

  /**
   * Family-membership cache backing `engine.getFamilyMembers()`
   * (analytics-core/spec.md §Family membership resolution — "cached
   * in-engine for 60 seconds, invalidated on `family:update`"). Keyed by
   * `${brand}:${familyId}` so a brand switch can never serve the previous
   * tenant's roster.
   */
  const FAMILY_MEMBERS_TTL_MS = 60_000
  let familyMembersCache:
    | { key: string, members: string[], expiresAt: number }
    | undefined

  config.eventBus?.subscribe('family:update', () => {
    familyMembersCache = undefined
  })

  async function getFamilyMembers(): Promise<string[]> {
    // Org tenants + local mode have no family fanout; unattached has no
    // tenant at all. Empty means "no fanout", never "denied".
    if (!currentCtx || currentCtx.tenantScope !== 'family')
      return []
    const r2 = config as Partial<R2AnalyticsConfig>
    if (typeof r2.familyMembersProvider !== 'function')
      return []

    const key = `${currentCtx.brand}:${currentCtx.tenantId}`
    const now = Date.now()
    if (familyMembersCache?.key === key && familyMembersCache.expiresAt > now) {
      return familyMembersCache.members
    }

    try {
      const members = await r2.familyMembersProvider({
        brand: currentCtx.brand,
        familyId: currentCtx.tenantId,
      })
      familyMembersCache = {
        key,
        members,
        expiresAt: now + FAMILY_MEMBERS_TTL_MS,
      }
      return members
    }
    catch (cause) {
      // Membership is an authorization input — a provider failure must not
      // be cached, and must not resolve to a permissive answer.
      log.error('analytics.getFamilyMembers: provider failed', {
        familyId: currentCtx.tenantId,
        err: describeError(cause),
      })
      familyMembersCache = undefined
      throw new AnalyticsError(
        'family_members_failed',
        `familyMembersProvider failed for ${currentCtx.tenantId}`,
        cause,
      )
    }
  }

  /**
   * Resolve the push watermark the pusher persists for `table`. Key format
   * must match sync/watermark.ts exactly:
   * `analytics:watermark:{brand}:{familyId}:{table}:push` → ISO string.
   * Reads the raw KVStore key (not WatermarkStore) because the sweep needs
   * "missing" to mean "nothing pushed — delete nothing", whereas
   * WatermarkStore.get substitutes a fresh-install horizon.
   */
  async function readPushWatermark(ctx: AttachContext, table: string): Promise<Date | null> {
    const iso = await config.storage.get<string>(
      `analytics:watermark:${ctx.brand}:${ctx.tenantId}:${table}:push`,
    )
    if (typeof iso === 'string') {
      const parsed = new Date(iso)
      if (!Number.isNaN(parsed.getTime()))
        return parsed
    }
    return null
  }

  /**
   * Load user override (if any), resolve effective retention against the
   * brand default from `AnalyticsConfig.retention`, run one sweep over the
   * LOCAL catalog. Errors are re-thrown; callers may choose to swallow
   * (attach-time sweep does).
   */
  async function sweep(ctx: AttachContext): Promise<void> {
    const brandCfg = config.retention[ctx.brand]
    const brandDefault = brandCfg?.days ?? 0
    const userOverride = (await loadRetentionOverride(config.storage, ctx)) ?? undefined
    const effectiveDays = resolveEffectiveRetention({ brandDefault, userOverride })
    if (effectiveDays <= 0)
      return
    const target = localCatalogName ?? await probeLocalCatalog(db)
    await runRetentionSweep(db, target, {
      effectiveDays,
      mode,
      // Local mode: no push exists (or ever will) — data is local-forever
      // by design, so the plain retention cutoff applies unguarded.
      getPushWatermark: isLocal ? undefined : table => readPushWatermark(ctx, table),
    })
  }

  /**
   * Await a state that permits an ATTACH transition. `createAnalytics` starts
   * the actor + sends OPEN synchronously; consumers that call `attach()`
   * immediately race the `opening → ready` transition. xstate drops events
   * from disallowed states, so without this guard the pending
   * `waitForNextState('attached'|'error')` would never resolve.
   *
   * Polls instead of `waitForNextState` to sidestep the race between reading
   * `currentState()` and installing the subscription: xstate can transition
   * between the two calls, at which point `waitForNextState`'s skip-first
   * logic swallows the transition we care about and blocks forever.
   */
  async function ensureReadyForAttach(): Promise<void> {
    for (let i = 0; i < 1000; i++) { // ~10s cap
      const s = currentState(actor)
      if (s === 'ready' || s === 'attached')
        return
      if (s === 'error') {
        throw actor.getSnapshot().context.lastError
          ?? new AnalyticsError('engine_open_failed', 'engine transitioned to error before ready')
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new AnalyticsError('engine_open_failed', 'engine never reached ready state within timeout')
  }

  const engine: AnalyticsEngine = {
    async attach(ctx: AttachContext) {
      await ensureReadyForAttach()
      const pending = waitForNextState(actor, ['attached', 'error'] as const)
      actor.send({ type: 'ATTACH', ctx })
      const final = await pending
      if (final === 'error') {
        throw actor.getSnapshot().context.lastError ?? new AnalyticsError('attach_failed', 'attach failed')
      }
      currentCtx = ctx
      // A previous tenant's roster must never survive a re-attach; the
      // cache key guards this too, but clearing here keeps brand-switch
      // isolation obvious. (Attach step 5 also resolves members, for
      // retention math, but the machine does not surface that result —
      // so the first getFamilyMembers() pays one provider call.)
      familyMembersCache = undefined
      log.info('analytics.attached', {
        brand: ctx.brand,
        tenantId: ctx.tenantId,
        tenantScope: ctx.tenantScope,
      })
      // Persistence + retention sweep are best-effort so a KV / DELETE
      // failure never rejects a successful attach.
      try {
        await saveLastAttach(config.storage, ctx)
      }
      catch (cause) {
        log.warn('analytics.persist.last_attach_failed', { cause })
      }
      try {
        await sweep(ctx)
      }
      catch (cause) {
        log.warn('analytics.retention.sweep_failed', { cause })
      }
    },
    async detach() {
      const ctxAtDetach = currentCtx
      const pending = waitForNextState(actor, ['ready', 'error'] as const)
      actor.send({ type: 'DETACH' })
      const final = await pending
      if (final === 'error') {
        throw actor.getSnapshot().context.lastError ?? new AnalyticsError('detach_failed', 'detach failed')
      }
      currentCtx = undefined
      if (ctxAtDetach) {
        log.info('analytics.detached', {
          brand: ctxAtDetach.brand,
          tenantId: ctxAtDetach.tenantId,
        })
        try {
          await clearLastAttach(config.storage, ctxAtDetach.brand)
        }
        catch (cause) {
          log.warn('analytics.persist.clear_last_attach_failed', { cause })
        }
      }
    },
    // `execute` declares `Promise<T[]>` — funnel the guard through a
    // rejected promise instead of a sync throw so all failures land on the
    // returned promise. `stream` / `createAppender` return synchronous
    // values, so a sync throw is the natural signal there.
    async execute(sql, params) {
      assertAttached(currentState(actor), 'execute')
      return db.execute(sql, params)
    },
    stream: (sql, params) => {
      assertAttached(currentState(actor), 'stream')
      return db.stream(sql, params)
    },
    createAppender: (table): AnalyticsAppender => {
      assertAttached(currentState(actor), `createAppender('${table}')`)
      return db.createAppender(table)
    },
    get state(): AnalyticsState {
      return currentState(actor)
    },
    get lastError(): Error | null {
      return actor.getSnapshot().context.lastError ?? null
    },
    get catalog(): string | undefined {
      return actor.getSnapshot().context.warehouseSecret
    },
    get mode() {
      return mode
    },
    subscribe(listener): Unsubscribe {
      publicSubscribers.add(listener)
      return () => publicSubscribers.delete(listener) as unknown as void
    },
    getFamilyMembers,
    async dismissInsight(args) {
      assertAttached(currentState(actor), 'dismissInsight')
      await dismissInsightImpl(args, {
        analytics: engine,
        eventBus: config.eventBus,
      })
    },
    async setRetention(days) {
      if (!currentCtx) {
        throw new AnalyticsError('not_attached', 'setRetention requires an attached engine')
      }
      await saveRetentionOverride(config.storage, currentCtx, days)
      await sweep(currentCtx)
    },
    async getLastAttach(brand: string) {
      return loadLastAttach(config.storage, brand)
    },
    async close() {
      log.info('analytics.closed')
      actor.send({ type: 'CLOSE' })
      internalSub.unsubscribe()
      publicSubscribers.clear()
      await db.close()
      actor.stop()
    },
  }

  return engine
}
