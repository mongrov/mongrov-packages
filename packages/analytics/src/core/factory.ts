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

import { createActor } from 'xstate'

import { AnalyticsError, NotImplementedError } from './errors'
import type { DuckDBFactory, DuckDBInstance } from './engine'
import { HybridDuckDB } from './engine'
import { bootstrapExtensions } from './extensions'
import { resolveLogger } from './logger'
import type { MachineActors } from './machine'
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
import type {
  AnalyticsAppender,
  AnalyticsConfig,
  AnalyticsEngine,
  AnalyticsState,
  AttachContext,
  Unsubscribe,
} from './types'
import {
  attachWarehouse,
  detachWarehouse,
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
 * *current* state at the time of subscription).
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

// -------------------- factory --------------------

export function createAnalytics(
  config: AnalyticsConfig,
  internal: CreateAnalyticsInternal = {},
): AnalyticsEngine {
  const log = resolveLogger(config.logger)
  const duckdbFactory = internal.duckdbFactory ?? defaultDuckdbFactory()
  const db = new HybridDuckDB(duckdbFactory)

  const machineActors: MachineActors = {
    async openEngine() {
      await db.open()
      await bootstrapExtensions(db)
    },
    async attachEngine({ ctx }) {
      const attach = await attachWarehouse(db, ctx, {
        warehouseUriBuilder: config.warehouseUriBuilder,
        tokenVendor: config.tokenVendor,
        familyMembersProvider: config.familyMembersProvider,
        catalogEndpoint: config.catalogEndpoint,
      })
      await ensureMigrations(
        db,
        config.storage,
        { brand: ctx.brand, tenantId: ctx.tenantId },
        attach.warehouseSecret,
      )
      return {
        warehouseSecret: attach.warehouseSecret,
        tokenExpiresAt: attach.tokenExpiresAt.getTime(),
      }
    },
    async detachEngine({ ctx }) {
      await detachWarehouse(db, ctx.tenantId)
    },
    async refreshToken({ ctx }) {
      const token = await config.tokenVendor.fetch({
        brand: ctx.brand,
        tenantScope: ctx.tenantScope,
        tenantId: ctx.tenantId,
      })
      const secretName = warehouseSecretName(ctx.tenantId)
      try {
        await db.execute(
          `CREATE OR REPLACE SECRET ${secretName} (TYPE ICEBERG, TOKEN $token, ENDPOINT $endpoint);`,
          { token: token.token, endpoint: config.catalogEndpoint },
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
   * Load user override (if any), resolve effective retention against the
   * brand default from `AnalyticsConfig.retention`, run one sweep. Errors
   * are re-thrown; callers may choose to swallow (attach-time sweep does).
   */
  async function sweep(ctx: AttachContext, catalog: string): Promise<void> {
    const brandCfg = config.retention[ctx.brand]
    const brandDefault = brandCfg?.days ?? 0
    const userOverride = (await loadRetentionOverride(config.storage, ctx)) ?? undefined
    const effectiveDays = resolveEffectiveRetention({ brandDefault, userOverride })
    if (effectiveDays <= 0) return
    await runRetentionSweep(db, catalog, { effectiveDays })
  }

  const engine: AnalyticsEngine = {
    async attach(ctx: AttachContext) {
      const pending = waitForNextState(actor, ['attached', 'error'] as const)
      actor.send({ type: 'ATTACH', ctx })
      const final = await pending
      if (final === 'error') {
        throw actor.getSnapshot().context.lastError ?? new AnalyticsError('attach_failed', 'attach failed')
      }
      currentCtx = ctx
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
      const catalog = actor.getSnapshot().context.warehouseSecret
      if (catalog) {
        try {
          await sweep(ctx, catalog)
        }
        catch (cause) {
          log.warn('analytics.retention.sweep_failed', { cause })
        }
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
    execute: (sql, params) => db.execute(sql, params),
    stream: (sql, params) => db.stream(sql, params),
    createAppender: (table): AnalyticsAppender => db.createAppender(table),
    get state(): AnalyticsState {
      return currentState(actor)
    },
    get lastError(): Error | null {
      return actor.getSnapshot().context.lastError ?? null
    },
    get catalog(): string | undefined {
      return actor.getSnapshot().context.warehouseSecret
    },
    subscribe(listener): Unsubscribe {
      publicSubscribers.add(listener)
      return () => publicSubscribers.delete(listener) as unknown as void
    },
    async setRetention(days) {
      if (!currentCtx) {
        throw new AnalyticsError('not_attached', 'setRetention requires an attached engine')
      }
      const catalog = actor.getSnapshot().context.warehouseSecret
      if (!catalog) {
        throw new AnalyticsError('not_attached', 'setRetention: no warehouse catalog')
      }
      await saveRetentionOverride(config.storage, currentCtx, days)
      await sweep(currentCtx, catalog)
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
