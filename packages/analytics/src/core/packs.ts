/**
 * Packs: how a domain plugs into the engine (techspec principle 73).
 *
 * The engine (factory, migrations, retention, views, sync chain, rules and
 * tools frameworks) is domain-free. Everything a domain brings — its tables,
 * migrations, retention, union and quality views, ingest adapters, post-flush
 * jobs, baselines, metrics, rule contexts, default rules and tools — arrives
 * as a pack, built with `definePack` and handed to the engine with
 * `registerPack` (or `createAnalytics({ packs })`).
 *
 * The platform pack (`insight`, `sync_watermark`, `tool_call_audit`,
 * `user_baseline`) is always registered. An app's `appSchema` (principle 71)
 * is one more pack, kept on its own config field for compatibility.
 *
 * Order matters and is stable: registered packs in registration order, then
 * the platform pack. Tables, retention, views and migrations all follow it.
 */

import type { DropReport } from '../sync/drops'
import type { HybridDuckDB } from './engine'
import type { MigrationCatalogs } from './migrations'
import type { AttachContext, KVStore } from './types'
import { DEFAULT_PACKS } from '../packs'
import { AnalyticsError } from './errors'
import { PLATFORM_PACK } from './platform-pack'

// -------------------- tables --------------------

export interface PackTableRetention {
  /** Timestamp column the retention DELETE compares. */
  tsColumn: string
  /** `sensor` follows the effective retention days; `insight` 90 d; `audit` 30 d. */
  kind: 'sensor' | 'insight' | 'audit'
  /**
   * Tenant columns every DELETE is scoped by. Default
   * `['brand', 'family_id', 'user_id']`; a table with no user column
   * (an audit log keyed by requester) narrows it.
   */
  tenantColumns?: readonly ('brand' | 'family_id' | 'user_id')[]
}

export interface PackTable {
  /**
   * `CREATE TABLE <name> (...)`, optionally ending in `PARTITIONED BY (...)`.
   * The remote (Iceberg) form; the local form strips `PARTITIONED BY` and
   * adds `identity` as a `PRIMARY KEY`.
   */
  ddl: string
  /** Watermark column for push / fetch, and for the `v_<table>` union view. */
  timeColumn: string
  /** Whether rows go to R2. Gates the retention sweep's push-watermark guard. */
  syncable: boolean
  /** `null` = never swept. */
  retention: PackTableRetention | null
  /** Never created in the attached R2 zone. */
  localOnly?: boolean
  /**
   * What identifies a row (principle 66). Becomes the local `PRIMARY KEY`
   * unless the DDL already declares one.
   */
  identity?: readonly string[]
  /** Read through a `v_<table>` union view (local rows past the push watermark + remote). */
  view?: boolean
  /**
   * Ingest validation (spec §13 S10): split rows into the ones to store and
   * a count, by reason, of the rest. Applied to every row buffered for the
   * table, through `SensorSink.push` and through ingest adapters alike.
   */
  validate?: (rows: readonly Record<string, unknown>[]) => DropReport
}

// -------------------- migrations --------------------

export interface PackMigration {
  /** Sequential from 1, per pack. */
  version: number
  name: string
  /** Idempotent DDL, called with the current attach's catalog set. */
  up: (db: HybridDuckDB, catalogs: MigrationCatalogs) => Promise<void>
}

// -------------------- quality views --------------------

/** One view or table macro a pack creates on every attach. */
export interface PackViewDdl {
  name: string
  sql: string
}

/**
 * Views a pack builds over the union views on every attach (and again on
 * `setQuality`), e.g. per-reading quality flags and the clean relations
 * claims read. The engine owns ordering, locking, the fatal/non-fatal split
 * and the bounded-read verdict; the pack owns the SQL.
 *
 * `options` is whatever the app passed as `AnalyticsConfig.quality` /
 * `setQuality`; the engine does not look inside it.
 */
export interface QualityViewProvider {
  /** Views, in creation order. A failure fails the attach. */
  views: (options: object) => PackViewDdl[]
  /** Bounded table macros, after the views. A failure is not fatal. */
  macros?: (options: object) => PackViewDdl[]
  /** Plain form of a macro, created under the same name when the bounded one fails. */
  fallbackMacro?: (name: string) => string
  /** Every view name this provider can create (for DROP). */
  viewNames: () => string[]
  /** Every macro name this provider can create (for DROP). */
  macroNames?: () => string[]
}

// -------------------- ingest --------------------

/** Who a batch of device output belongs to. */
export interface IngestContext {
  brand: string
  familyId: string
  userId: string
  deviceId: string
  /** IANA zone of the user, for adapters that bucket by local time. */
  userTimezone?: string
}

/** What an adapter may use while it maps. */
export interface IngestDeps {
  /** Query or write the local catalog (attached engine). */
  execute: <T = Record<string, unknown>>(sql: string, params?: Record<string, unknown>) => Promise<T[]>
  /** Tables the sync manager flushes (`createSyncManager({ tables })`). */
  tables: readonly string[]
  /** The app's key-value store, for an adapter's own bookkeeping. */
  storage: KVStore
  /** The sync manager's attach context. */
  attach: AttachContext
}

/** Rows to buffer, by table, in order. */
export type IngestRows = ReadonlyArray<readonly [table: string, rows: readonly Record<string, unknown>[]]>

/**
 * Turns one device's raw output into rows (`SensorSink.ingest(name, raw,
 * ctx)`). The engine then validates each table's rows with the table's
 * `validate`, counts what is dropped, buffers the rest and tells post-flush
 * jobs what arrived. Runs before anything is buffered, so it may first read
 * or update the local catalog (e.g. close SCD-2 rows it supersedes).
 */
export interface IngestAdapter<TRaw = unknown, TCtx extends IngestContext = IngestContext> {
  ingest: (raw: TRaw, ctx: TCtx, deps: IngestDeps) => Promise<IngestRows>
}

/** What a pack's sync hooks may use. */
export interface SyncHookDeps {
  /** Run statements against one remote table, with the pusher's auth retry and events. */
  pushRemote: (
    table: string,
    run: (remoteTable: string, execute: (sql: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<number>,
  ) => Promise<{ ok: boolean, error?: Error }>
  storage: KVStore
  tables: readonly string[]
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }
}

/** Steps a pack adds to each scheduled sync cycle (r2 mode only). */
export interface PackSyncHooks {
  /** After the cycle's push, before its fetch. */
  afterPush?: (ctx: AttachContext, deps: SyncHookDeps) => Promise<void>
}

// -------------------- the pack --------------------

export interface AnalyticsPack {
  /** Lowercase identifier, unique among registered packs. */
  name: string
  tables?: Readonly<Record<string, PackTable>>
  /**
   * Run on every attach after the previous pack's. A pack creates its own
   * tables in a migration (`ensurePackTables`), so an existing install
   * replays nothing it already has.
   */
  migrations?: readonly PackMigration[]
  /**
   * KV key holding this pack's applied migration version. Default
   * `analytics:pack_schema_version:<name>:<brand>:<tenantId>`. A pack that
   * inherits an existing install's ledger names that key here so its
   * history is kept rather than replayed.
   */
  versionKey?: (brand: string, tenantId: string) => string
  /** Older spellings of `versionKey`, adopted once and deleted. */
  legacyVersionKeys?: (brand: string, tenantId: string) => string[]
  /**
   * Seed this pack's version from another ledger when its own key is absent
   * — for steps that used to run under that ledger. Read once, before any
   * pack migrates, from the first key that holds a number.
   */
  adoptVersion?: {
    keys: (brand: string, tenantId: string) => string[]
    map: (ledgerVersion: number) => number
  }
  quality?: QualityViewProvider
  /** Ingest adapters by name (`SensorSink.ingest(name, raw, ctx)`). */
  ingest?: Readonly<Record<string, IngestAdapter<any, any>>>
  sync?: PackSyncHooks
  /** Free-form extensions read by other subsystems (ingest, post-flush, rules, tools). */
  [extension: string]: unknown
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/
const NAME_RE = /^[a-z][a-z0-9_-]*$/

function hasColumn(ddl: string, column: string): boolean {
  return IDENT_RE.test(column) && new RegExp(`[(,]\\s*${column}\\s+[A-Z]`, 'i').test(ddl)
}

/**
 * Check a pack's shape and return it. Throws `AnalyticsError('invalid_config')`
 * naming the first problem, so a malformed pack fails where it is defined.
 */
export function definePack<P extends AnalyticsPack>(pack: P): P {
  const fail = (message: string): never => {
    throw new AnalyticsError('invalid_config', `pack ${pack.name}: ${message}`)
  }
  if (!NAME_RE.test(pack.name))
    fail(`name must match ${NAME_RE}`)
  for (const [name, table] of Object.entries(pack.tables ?? {})) {
    if (!IDENT_RE.test(name))
      fail(`table name "${name}" must match ${IDENT_RE}`)
    if (name.startsWith('v_'))
      fail(`"${name}": the v_ prefix is reserved for views`)
    if (!table.ddl.trimStart().startsWith(`CREATE TABLE ${name} (`))
      fail(`"${name}": ddl must start with "CREATE TABLE ${name} ("`)
    if (!hasColumn(table.ddl, table.timeColumn))
      fail(`"${name}": timeColumn "${table.timeColumn}" is not a column`)
    if (table.retention && !hasColumn(table.ddl, table.retention.tsColumn))
      fail(`"${name}": retention.tsColumn "${table.retention.tsColumn}" is not a column`)
    for (const col of table.identity ?? []) {
      if (!hasColumn(table.ddl, col))
        fail(`"${name}": identity column "${col}" is not a column`)
    }
  }
  ;(pack.migrations ?? []).forEach((m, i) => {
    if (m.version !== i + 1)
      fail(`migration "${m.name}" has version ${m.version}, expected ${i + 1}`)
  })
  return pack
}

// -------------------- registry --------------------

let defaultsLoaded = false
const registered: AnalyticsPack[] = []
let cache: ReturnType<typeof index> | undefined

function loadDefaults(): void {
  if (defaultsLoaded)
    return
  defaultsLoaded = true
  for (const pack of DEFAULT_PACKS) {
    if (!registered.some(p => p.name === pack.name))
      registered.push(pack)
  }
}

/**
 * Register a pack. Registering the same pack object again is a no-op; a
 * different pack under a registered name replaces it in place (its position
 * is kept). A table already owned by another pack is rejected.
 */
export function registerPack(pack: AnalyticsPack): void {
  definePack(pack)
  loadDefaults()
  if (pack.name === PLATFORM_PACK.name)
    throw new AnalyticsError('invalid_config', `pack ${pack.name}: name is reserved`)
  const at = registered.findIndex(p => p.name === pack.name)
  if (at >= 0 && registered[at] === pack)
    return
  const owners = new Map<string, string>()
  for (const p of [...registered, PLATFORM_PACK]) {
    if (p.name === pack.name)
      continue
    for (const t of Object.keys(p.tables ?? {})) owners.set(t, p.name)
  }
  for (const t of Object.keys(pack.tables ?? {})) {
    const owner = owners.get(t)
    if (owner)
      throw new AnalyticsError('invalid_config', `pack ${pack.name}: table "${t}" is already owned by pack ${owner}`)
  }
  if (at >= 0)
    registered[at] = pack
  else
    registered.push(pack)
  cache = undefined
}

/** Register several packs, in order. */
export function registerPacks(packs: readonly AnalyticsPack[]): void {
  for (const p of packs) registerPack(p)
}

/** @internal Tests: drop every registered pack (defaults reload on next lookup). */
export function resetPacks(): void {
  registered.length = 0
  defaultsLoaded = false
  cache = undefined
}

/** Every pack the engine uses, in order: registered packs, then the platform. */
export function getPacks(): readonly AnalyticsPack[] {
  return lookup().packs
}

/** Look a pack up by name. */
export function getPack(name: string): AnalyticsPack | undefined {
  return lookup().packs.find(p => p.name === name)
}

/** One table's declaration, from whichever pack owns it. */
export function packTable(name: string): PackTable | undefined {
  return lookup().tables.get(name)
}

/** Every pack table, in pack order then declaration order. */
export function packTables(): ReadonlyMap<string, PackTable> {
  return lookup().tables
}

/** Tables read through a `v_<table>` union view, in pack order. */
export function viewedTables(): readonly string[] {
  return lookup().viewed
}

/** Every pack's quality views, in pack order. */
export function qualityProviders(): readonly QualityViewProvider[] {
  return lookup().quality
}

/** An ingest adapter by name, from the first pack that declares it. */
export function ingestAdapter(name: string): IngestAdapter<any, any> | undefined {
  for (const p of lookup().packs) {
    const a = p.ingest?.[name]
    if (a)
      return a
  }
  return undefined
}

/** A named extension from every pack that declares it, in pack order. */
export function packExtensions<T>(key: string): T[] {
  return lookup().packs.flatMap(p => (p[key] === undefined ? [] : [p[key] as T]))
}

function lookup() {
  loadDefaults()
  cache ??= index()
  return cache
}

function index() {
  const packs = [...registered, PLATFORM_PACK]
  const tables = new Map<string, PackTable>()
  for (const p of packs) {
    for (const [name, t] of Object.entries(p.tables ?? {})) tables.set(name, t)
  }
  const viewed = [...tables].filter(([, t]) => t.view).map(([name]) => name)
  const quality = packs.flatMap(p => (p.quality ? [p.quality] : []))
  return { packs, tables, viewed, quality }
}
