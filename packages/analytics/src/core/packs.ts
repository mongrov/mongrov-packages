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

import type { ZodTypeAny } from 'zod'
import type { SensorBuffer } from '../sync/buffer'
import type { DropReport } from '../sync/drops'
import type { BatchFlusher, FlushReason } from '../sync/flusher'
import type { SchedulerLogger } from '../sync/scheduler'
import type { FlushResult } from '../sync/types'
import type { ToolImpl } from '../tools/types'
import type { HybridDuckDB } from './engine'
import type { MigrationCatalogs } from './migrations'
import type { AttachContext, KVStore } from './types'
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
  /** The relations claims read for the tables this provider covers. */
  relations?: {
    has: (table: string) => boolean
    /** What claims read (e.g. `v_<table>_clean`). */
    clean: (table: string) => string
    /** Per-reading flags (e.g. `v_<table>_q`). */
    quality: (table: string) => string
  }
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

// -------------------- post-flush jobs --------------------

/** Rows one ingest call or `SensorSink.push` buffered for a table. */
export interface NotedRows {
  brand: string
  familyId: string
  userId: string
  deviceId: string
  rows: ReadonlyArray<Record<string, unknown>>
}

/** What a post-flush job is built with, once per sync manager. */
export interface PostFlushDeps {
  /** The attached engine (local catalog reads and writes). */
  engine: HybridDuckDB
  /** Buffer rows for this batch; flush them with `flusher.flush(table, reason, batchId)`. */
  buffer: SensorBuffer
  flusher: BatchFlusher
  /** Tables the sync manager flushes. */
  tables: readonly string[]
  /** A user's IANA zone (`userTimezoneProvider`, else the device's). */
  resolveTimezone: (userId: string) => Promise<string>
  logger?: SchedulerLogger
  /** The `createSyncManager` config, for a job's own options. */
  options: Readonly<Record<string, unknown>>
}

/** One sync manager's instance of a job. */
export interface PostFlushRunner {
  /** Rows were buffered for `table` (before validation, for ingest adapters). */
  noteRows?: (table: string, batch: NotedRows) => void
  /**
   * Runs in every batch after its tables flushed and before
   * `batch:complete`, in pack order; may buffer and flush rows of its own
   * into `batchId`. Resolves with those flush results; must not throw.
   */
  run: (batchId: string, reason: FlushReason) => Promise<FlushResult[]>
}

/** Work that follows each flush (`pack.postFlush`), e.g. deriving tables from raw ones. */
export interface PostFlushJob {
  name: string
  /** Build the job for one sync manager, or `undefined` when it does not apply. */
  create: (deps: PostFlushDeps) => PostFlushRunner | undefined
}

// -------------------- baselines --------------------

/**
 * One baseline the engine computes per user and window and stores in the
 * platform's `user_baseline` table. The query binds `$userId`, `$brand`,
 * `$familyId`, `$tz` and `$windowDays`, and returns quantile columns
 * (`p05 p10 p50 p90 p95 mean stddev sample_count`).
 */
export interface BaselineDefinition {
  /** `user_baseline.metric` for a `one` definition; a label for `many`. */
  key: string
  /**
   * `one`: a single row for `key`, written when `sample_count >= minDays`.
   * `many`: rows each carrying their own `metric`, all written.
   */
  rows: 'one' | 'many'
  minDays?: number
  /** `many` only: rows a full result has; the rest count as skipped. */
  expected?: number
  /** The query; with `bounded`, its bounded-read form, or `undefined` when it has none. */
  sql: (windowDays: number, bounded: boolean) => string | undefined
}

/** A pack's baselines (`pack.baselines`). */
export interface BaselineProvider {
  /** Windows (days) each definition is computed over. */
  windows: readonly number[]
  /** The definitions, given the `createBaselineComputer` / sync config options. */
  definitions: (options: Readonly<Record<string, unknown>>) => BaselineDefinition[]
}

// -------------------- rules --------------------

/** What a rule context's join is built from. `m` aliases the metric relation. */
export interface RuleContextArgs {
  /** The metric's table. */
  table: string
  /** The per-reading quality relation to join, when the read is bounded. */
  qualityRelation?: string
}

/** A key-value setting registry rules may read thresholds from. */
export interface RuleSettings {
  /** Registered and meant as a threshold. */
  readable: (key: string) => boolean
  /** Registered at all (UX state included). */
  registered: (key: string) => boolean
  /** The registered value type (`number`, `string`, …). */
  valueType: (key: string) => string | undefined
  /** The registered numeric range, when the key declares one. */
  range?: (key: string) => readonly [number, number] | undefined
  /** Every rule-readable key, for messages. */
  readableKeys: () => string[]
  /** Where a new key is added, for messages. */
  registryName: string
}

/** What a pack adds to the rules engine (`pack.rules`). */
export interface RulePack {
  /**
   * Named sample contexts: the JOIN restricting a rule's samples (`any`, no
   * join, is the engine's). Context is a JOIN, not a post-filter.
   */
  contexts?: Readonly<Record<string, (args: RuleContextArgs) => string>>
  /** Windows a metric allows, when its sampling alone does not decide. */
  windows?: Readonly<Record<string, readonly string[]>>
  /** Structural checks on a parsed rule (throw `RuleValidationError`). */
  validate?: (rule: { id: string, metric: string, context: string, target: { type: string } }) => void
  /** Admission policy at registration (throw `RuleValidationError`). */
  admit?: (rule: { id: string, metric: string, target: { type: string } }) => void
  /** Settings `user_setting` targets and phase-band scales may read. */
  settings?: RuleSettings
  /** Brand for rules registered without one. */
  defaultBrand?: string
}

// -------------------- tools --------------------

/** One AI tool a pack offers (`pack.tools`); the framework wraps it. */
export interface PackTool {
  /** What the model reads to decide when to call it. */
  description: string
  /** Zod schema of the arguments. */
  inputSchema: ZodTypeAny
  impl: ToolImpl<any>
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
  /** Jobs run after each flush, inside the batch. */
  postFlush?: readonly PostFlushJob[]
  baselines?: BaselineProvider
  /** Metrics by id (`MetricDefinition`). */
  metrics?: Readonly<Record<string, import('./metrics').MetricDefinition>>
  rules?: RulePack
  /**
   * AI tools by name, wrapped by `createAnalyticsTools` with the shared
   * authorization, rate limit, audit and output budget.
   */
  tools?: Readonly<Record<string, PackTool>>
  /** Checks text a tool returns (throws when it breaks the pack's copy rules). */
  copyGuard?: (text: string, source: string) => void
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
let defaultPacks: readonly AnalyticsPack[] = []
const registered: AnalyticsPack[] = []
let cache: ReturnType<typeof index> | undefined

/**
 * @internal Packs registered before the first lookup, and again after
 * `resetPacks` — for test suites that exercise the engine with a pack.
 */
export function setDefaultPacks(packs: readonly AnalyticsPack[]): void {
  defaultPacks = packs
  defaultsLoaded = false
  registered.length = 0
  cache = undefined
}

function loadDefaults(): void {
  if (defaultsLoaded)
    return
  defaultsLoaded = true
  for (const pack of defaultPacks) {
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
