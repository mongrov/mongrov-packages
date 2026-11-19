import type { Migration } from '../migrations'

import { describe, expect, it } from 'vitest'
import { CURRENT_VERSION, IDENTITY_COLUMNS, LOCAL_ONLY_TABLES, TABLE_NAMES } from '../../__tests__/packs/legacy-tables'
import { HybridDuckDB } from '../engine'
import {
  ensureMigrations,
  schemaVersionKey,
} from '../migrations'
import { PLATFORM_TABLE_NAMES } from '../platform-tables'

import { createFakeDuckDB } from './__fakes__/fake-duckdb'
import { createFakeKV } from './__fakes__/fake-kv'

async function newOpenDb() {
  const fake = createFakeDuckDB()
  const db = new HybridDuckDB(fake.factory)
  await db.open()
  return { fake, db }
}

/**
 * DDL counts, derived from TABLE_NAMES so adding a table does not require
 * retuning every count in this file.
 *
 * Since packs (S-02) two ledgers run: the health pack keeps the package's
 * steps 1-8 under `schemaVersionKey` (3 and 4 are no-ops there now), then
 * the platform pack runs its own two steps (its tables, then insight v2).
 * Local gets every table; remote skips the local-only ones.
 */
const PLATFORM_COUNT = PLATFORM_TABLE_NAMES.length
const HEALTH_COUNT = TABLE_NAMES.length - PLATFORM_COUNT
/** Health step 1: its tables locally, then remotely. */
const HEALTH_BASELINE_COUNT = 2 * HEALTH_COUNT
/** Platform step 1: its tables locally + all-but-local-only remotely. */
const PLATFORM_BASELINE_COUNT = PLATFORM_COUNT + PLATFORM_COUNT - LOCAL_ONLY_TABLES.size
const LOCAL_DDL_COUNT = HEALTH_COUNT
/** step-2 re-ensures device_battery in both catalogs. */
const STEP2_COUNT = 2
/**
 * Insight v2 (platform step 2, package step 3 before packs) issues 8
 * statements: the fake returns no columns for the probe, so the recreate
 * path runs (probe + drop scratch + create scratch + copy + drop + rename +
 * index + remote).
 */
const INSIGHT_V2_COUNT = 8
/**
 * step-5 (device_config data_type -> metric) probes information_schema and
 * returns early on a fresh install, where the baseline already created the
 * new shape. One statement.
 */
const STEP5_COUNT = 1
/**
 * step-6 (identity keys, principle 66) probes `listColumns` once per table in
 * `IDENTITY_COLUMNS`. The fake returns no columns, so every table is treated
 * as absent and the rebuild is skipped — one statement each, no DDL. Derived
 * from the map rather than hard-coded so declaring an eleventh identity table
 * does not silently break this count.
 */
const STEP6_COUNT = Object.keys(IDENTITY_COLUMNS).length
/**
 * step-7 (temp_c INTEGER -> DECIMAL) probes `listColumns` for `temperature`.
 * The fake returns no columns, so the table reads as absent and the rebuild
 * is skipped — one statement.
 */
const STEP7_COUNT = 1
/**
 * step-8 (sleep-correction columns) probes `listColumns` for `sleep_session`
 * and `sleep_stage`. The fake returns no columns, so both read as absent and
 * the rebuilds are skipped — one statement each.
 */
const STEP8_COUNT = 2
/** Health steps 2-8 (3 and 4 issue nothing). */
const HEALTH_UPGRADE_COUNT = STEP2_COUNT + STEP5_COUNT + STEP6_COUNT + STEP7_COUNT + STEP8_COUNT
/** Both platform steps. */
const PLATFORM_ALL_COUNT = PLATFORM_BASELINE_COUNT + INSIGHT_V2_COUNT
const FRESH_COUNT = HEALTH_BASELINE_COUNT + HEALTH_UPGRADE_COUNT + PLATFORM_ALL_COUNT

const CTX = { brand: 'brandA', tenantId: 'fam123' }
const CATALOG = 'zone_fam123'
const KEY = schemaVersionKey(CTX.brand, CTX.tenantId)

describe('ensureMigrations', () => {
  it('first run: KV empty → runs baseline, KV persisted to CURRENT_VERSION', async () => {
    const { fake, db } = await newOpenDb()
    const { kv, store } = createFakeKV()

    const result = await ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })

    expect(result).toEqual({ from: 0, to: CURRENT_VERSION })
    expect(store.get(KEY)).toBe(CURRENT_VERSION)
    // Each baseline issues local DDL in the local catalog + remote DDL in the
    // remote catalog (0.5.0 fix for "ensureSchemas never creates local.*
    // tables"), minus the local-only tables remote-side; then the later steps.
    expect(fake.calls).toHaveLength(FRESH_COUNT)
    // Local tables come first (baseline migration order).
    expect(fake.calls[0].sql).toContain('CREATE TABLE IF NOT EXISTS memory.hrv')
    expect(fake.calls[0].sql).not.toContain('PARTITIONED BY')
    // Then remote tables with PARTITIONED BY.
    expect(fake.calls[LOCAL_DDL_COUNT].sql).toContain('CREATE TABLE IF NOT EXISTS zone_fam123.default.hrv')
    expect(fake.calls[LOCAL_DDL_COUNT].sql).toContain('PARTITIONED BY')
  })

  it('same-version rerun: no DDL issued, KV unchanged', async () => {
    const { fake, db } = await newOpenDb()
    const { kv, store } = createFakeKV()
    store.set(KEY, CURRENT_VERSION)

    const result = await ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })

    expect(result).toEqual({ from: CURRENT_VERSION, to: CURRENT_VERSION })
    expect(fake.calls).toHaveLength(0)
    expect(store.get(KEY)).toBe(CURRENT_VERSION)
  })

  it('per-family isolation: familyA at v1 does not affect familyB at v0', async () => {
    const { db } = await newOpenDb()
    const { kv, store } = createFakeKV()
    store.set(schemaVersionKey('brandA', 'famA'), CURRENT_VERSION)

    const resultA = await ensureMigrations(db, kv, { brand: 'brandA', tenantId: 'famA' }, { local: 'memory', remote: 'zone_famA' })
    const resultB = await ensureMigrations(db, kv, { brand: 'brandA', tenantId: 'famB' }, { local: 'memory', remote: 'zone_famB' })

    expect(resultA).toEqual({ from: CURRENT_VERSION, to: CURRENT_VERSION })
    expect(resultB).toEqual({ from: 0, to: CURRENT_VERSION })
    expect(store.get(schemaVersionKey('brandA', 'famA'))).toBe(CURRENT_VERSION)
    expect(store.get(schemaVersionKey('brandA', 'famB'))).toBe(CURRENT_VERSION)
  })

  it('failure at a migration step surfaces as migration_failed and leaves KV at prior success', async () => {
    // Build a fake migration list by monkey-patching the second entry — since
    // the module exports the array as `readonly`, we can't append. Instead,
    // simulate failure by making the underlying ensureSchemas DDL throw.
    const { fake, db } = await newOpenDb()
    const { kv, store } = createFakeKV()

    const cause = new Error('boom')
    fake.failNextExecute(cause)

    await expect(ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })).rejects.toMatchObject({
      code: 'migration_failed',
      message: expect.stringContaining('step-1'),
    })
    // Baseline failed → KV never set.
    expect(store.get(KEY)).toBeUndefined()
  })

  it('upgrade from v1 runs step-2 then step-3 (device_battery, insight v2)', async () => {
    const { fake, db } = await newOpenDb()
    const { kv, store } = createFakeKV()
    store.set(KEY, 1)

    const result = await ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })

    expect(result).toEqual({ from: 1, to: CURRENT_VERSION })
    expect(store.get(KEY)).toBe(CURRENT_VERSION)
    // Step-2: local (no PARTITIONED BY) + remote (with) device_battery.
    expect(fake.calls[0].sql).toContain('CREATE TABLE IF NOT EXISTS memory.device_battery')
    expect(fake.calls[0].sql).not.toContain('PARTITIONED BY')
    expect(fake.calls[1].sql).toContain('CREATE TABLE IF NOT EXISTS zone_fam123.default.device_battery')
    expect(fake.calls[1].sql).toContain('PARTITIONED BY (day(ts), device_id)')
    // Health steps 3-8 follow, then both platform steps: a ledger below 4
    // replays them, each idempotent (see first-run test).
    expect(fake.calls).toHaveLength(HEALTH_UPGRADE_COUNT + PLATFORM_ALL_COUNT)
  })

  it('upgrade from v2 runs only step-3 — insight recreate with data mapping', async () => {
    const { fake, db } = await newOpenDb()
    const { kv, store } = createFakeKV()
    store.set(KEY, 2)

    const result = await ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })

    expect(result).toEqual({ from: 2, to: CURRENT_VERSION })
    const sqls = fake.calls.map(c => c.sql)
    // A column probe on the local catalog gates the recreate. It uses
    // PRAGMA table_info rather than information_schema, which lives in the
    // `system` catalog the iOS DuckDB build cannot resolve. (Platform step 2
    // now, after the health ledger's steps 3-8.)
    const probe = sqls.findIndex(s => s.includes('PRAGMA table_info') && s.includes('insight'))
    expect(probe).toBeGreaterThan(-1)
    expect(sqls.slice(probe).some(s => s.startsWith('INSERT INTO memory.insight_v2'))).toBe(true)
    // Copy preserves rows with id → insight_id, kind default 'threshold',
    // and severity 'critical' → 'urgent'.
    const copy = sqls.find(s => s.startsWith('INSERT INTO memory.insight_v2'))
    expect(copy).toBeDefined()
    expect(copy).toContain(`'threshold'`)
    expect(copy).toContain(`CASE WHEN severity = 'critical' THEN 'urgent' ELSE severity END`)
    expect(sqls).toContain('DROP TABLE memory.insight;')
    expect(sqls).toContain('ALTER TABLE memory.insight_v2 RENAME TO insight;')
    // Lookup index per spec — local catalog only.
    expect(sqls.some(s => s.includes('CREATE INDEX IF NOT EXISTS idx_insight_lookup ON memory.insight (user_id, metric, dismissed_at, ts)'))).toBe(true)
    // Remote gets non-destructive CREATE IF NOT EXISTS only.
    expect(sqls.some(s => s.includes('CREATE TABLE IF NOT EXISTS zone_fam123.default.insight'))).toBe(true)
    expect(sqls.some(s => s.includes('DROP TABLE zone_fam123'))).toBe(false)
  })

  it('multi-step upgrade path applies only newer migrations', async () => {
    // Pre-set KV to a version below CURRENT_VERSION, observe that
    // every remaining migration runs in order.
    const { fake, db } = await newOpenDb()
    const { kv, store } = createFakeKV()

    // Start from before baseline (as if a new tenant).
    const result = await ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })
    expect(result.from).toBe(0)
    expect(result.to).toBe(CURRENT_VERSION)
    expect(fake.calls.length).toBe(FRESH_COUNT)

    // Same call again — no-op. KV already at CURRENT_VERSION.
    fake.calls.length = 0
    const result2 = await ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })
    expect(result2.from).toBe(CURRENT_VERSION)
    expect(result2.to).toBe(CURRENT_VERSION)
    expect(fake.calls.length).toBe(0)
    expect(store.get(KEY)).toBe(CURRENT_VERSION)
  })
})

describe('schemaVersionKey', () => {
  it('composes analytics:schema_version:<brand>:<tenantId>', () => {
    expect(schemaVersionKey('brandA', 'fam123')).toBe('analytics:schema_version:brandA:fam123')
  })
})

describe('legacy key migration (T-23)', () => {
  const LEGACY_KEY = 'analytics:schema-version:brandA:fam123'

  it('adopts legacy hyphenated key when canonical key is absent, then deletes the legacy entry', async () => {
    const { fake, db } = await newOpenDb()
    const { kv, store } = createFakeKV()
    store.set(LEGACY_KEY, CURRENT_VERSION)

    const result = await ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })

    expect(result).toEqual({ from: CURRENT_VERSION, to: CURRENT_VERSION })
    expect(store.get(KEY)).toBe(CURRENT_VERSION)
    expect(store.get(LEGACY_KEY)).toBeUndefined()
    expect(fake.calls).toHaveLength(0)
  })

  it('canonical key wins over legacy when both are present (legacy left untouched by ensureMigrations)', async () => {
    const { db } = await newOpenDb()
    const { kv, store } = createFakeKV()
    store.set(KEY, CURRENT_VERSION)
    store.set(LEGACY_KEY, 0)

    const result = await ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })

    expect(result).toEqual({ from: CURRENT_VERSION, to: CURRENT_VERSION })
    expect(store.get(KEY)).toBe(CURRENT_VERSION)
    // Legacy key untouched — the one-shot branch never fired because
    // canonical key was present. Cleanup of orphan legacy keys is
    // out of scope for the migration runner.
    expect(store.get(LEGACY_KEY)).toBe(0)
  })
})

describe('migration 3 — insight v2 against a live local DuckDB', () => {
  const OLD_INSIGHT_DDL = `CREATE TABLE memory.insight (
  id VARCHAR PRIMARY KEY,
  ts TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  rule_id VARCHAR,
  severity VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  body TEXT,
  evidence VARCHAR,
  acknowledged_at TIMESTAMP
);`

  async function bootReal() {
    const { createRealDuckDB } = await import('../../__integration__/setup/real-engine')
    const { HybridDuckDB: Hybrid } = await import('../engine')
    const db = new Hybrid(() => createRealDuckDB([]))
    await db.open()
    return db
  }

  it('fresh DB: full run yields the v2 shape + lookup index', async () => {
    const db = await bootReal()
    try {
      const { kv } = createFakeKV()
      await ensureMigrations(db, kv, CTX, { local: 'memory' })

      const cols = await db.execute<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'insight'`,
      )
      const names = new Set(cols.map(c => c.column_name))
      expect(names.has('insight_id')).toBe(true)
      expect(names.has('metric')).toBe(true)
      expect(names.has('kind')).toBe(true)
      expect(names.has('dismissed_at')).toBe(true)
      expect(names.has('id')).toBe(false)

      const indexes = await db.execute<{ index_name: string }>(
        `SELECT index_name FROM duckdb_indexes() WHERE table_name = 'insight'`,
      )
      expect(indexes.map(i => i.index_name)).toContain('idx_insight_lookup')
    }
    finally {
      await db.close()
    }
  })

  it('old-shape table: rows preserved, critical → urgent, kind defaults to threshold', async () => {
    const db = await bootReal()
    try {
      const { kv, store } = createFakeKV()
      await db.execute(OLD_INSIGHT_DDL)
      await db.execute(
        `INSERT INTO memory.insight (id, ts, brand, family_id, user_id, severity, title, body)
         VALUES ('old-1', now(), 'b', 'f', 'u', 'critical', 'Old alert', 'legacy row')`,
      )
      store.set(KEY, 2) // step-3 pending only

      await ensureMigrations(db, kv, CTX, { local: 'memory' })

      const rows = await db.execute<{
        insight_id: string
        metric: string
        kind: string
        severity: string
        title: string
        dismissed_at: unknown
      }>(`SELECT insight_id, metric, kind, severity, title, dismissed_at FROM memory.insight`)
      expect(rows).toHaveLength(1)
      expect(rows[0].insight_id).toBe('old-1')
      expect(rows[0].kind).toBe('threshold')
      expect(rows[0].severity).toBe('urgent')
      expect(rows[0].metric).toBe('unknown')
      expect(rows[0].title).toBe('Old alert')
      expect(rows[0].dismissed_at).toBeNull()
    }
    finally {
      await db.close()
    }
  })

  it('running step-3 twice is a no-op the second time (metric column present)', async () => {
    const db = await bootReal()
    try {
      const { kv, store } = createFakeKV()
      await db.execute(OLD_INSIGHT_DDL)
      await db.execute(
        `INSERT INTO memory.insight (id, ts, brand, family_id, user_id, severity, title)
         VALUES ('old-1', now(), 'b', 'f', 'u', 'warn', 'Keep me')`,
      )
      store.set(KEY, 2)
      await ensureMigrations(db, kv, CTX, { local: 'memory' })

      // Force step-3 to run again — the metric-column guard must skip the
      // recreate and preserve the migrated row.
      store.set(KEY, 2)
      await ensureMigrations(db, kv, CTX, { local: 'memory' })

      const rows = await db.execute<{ insight_id: string, severity: string }>(
        `SELECT insight_id, severity FROM memory.insight`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ insight_id: 'old-1', severity: 'warn' })
    }
    finally {
      await db.close()
    }
  })
})

describe('MIGRATIONS shape', () => {
  it('CURRENT_VERSION equals MIGRATIONS length', async () => {
    // Import here to avoid a top-level cycle in the assertions above.
    const { MIGRATIONS } = await import('../../__tests__/packs/legacy-tables')
    expect(CURRENT_VERSION).toBe(MIGRATIONS.length)
    for (let i = 0; i < MIGRATIONS.length; i++) {
      const m = MIGRATIONS[i] as Migration
      expect(m.version).toBe(i + 1)
    }
  })
})

describe('platform pack ledger (package-separation S-02)', () => {
  const PLATFORM_KEY = 'analytics:pack_schema_version:platform:brandA:fam123'

  it('an install at package step 4+ adopts platform 2 and replays nothing of it', async () => {
    const { fake, db } = await newOpenDb()
    const { kv, store } = createFakeKV()
    store.set(KEY, 4)

    const result = await ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })

    expect(result).toEqual({ from: 4, to: CURRENT_VERSION })
    expect(store.get(PLATFORM_KEY)).toBe(2)
    // Health steps 5-8 only; no platform DDL.
    expect(fake.calls).toHaveLength(STEP5_COUNT + STEP6_COUNT + STEP7_COUNT + STEP8_COUNT)
    expect(fake.calls.some(c => c.sql.includes('insight'))).toBe(false)
  })

  it('an install below package step 4 replays both platform steps', async () => {
    const { db } = await newOpenDb()
    const { kv, store } = createFakeKV()
    store.set(KEY, 3)

    await ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })

    expect(store.get(PLATFORM_KEY)).toBe(2)
  })

  it('persists the adopted platform version 0 before any pack runs (pre-step-4 install)', async () => {
    const { fake, db } = await newOpenDb()
    const { kv, store } = createFakeKV()
    store.set(KEY, 3)
    // Fail every platform statement: the pack ledger completes, the platform's never starts.
    fake.failExecuteMatching(/CREATE TABLE IF NOT EXISTS memory\.insight/, new Error('injected'))

    await expect(ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })).rejects.toThrow(/platform/)

    expect(store.get(KEY)).toBe(CURRENT_VERSION)
    expect(store.get(PLATFORM_KEY)).toBe(0)
  })

  it('an interrupted first attach from a pre-step-4 install retries the platform steps', async () => {
    const { fake, db } = await newOpenDb()
    const { kv, store } = createFakeKV()
    store.set(KEY, 3)
    fake.failExecuteMatching(/CREATE TABLE IF NOT EXISTS memory\.insight/, new Error('injected'))
    await expect(ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })).rejects.toThrow()

    // Re-attach. The ledger adopted from now reads CURRENT_VERSION (>= 4);
    // re-adopting would map it to 2 and skip both platform steps.
    fake.clearExecuteMatchFailure()
    fake.calls.length = 0
    await ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })

    expect(store.get(PLATFORM_KEY)).toBe(2)
    expect(fake.calls.some(c => c.sql.includes('CREATE TABLE IF NOT EXISTS memory.insight'))).toBe(true)
    expect(fake.calls).toHaveLength(PLATFORM_ALL_COUNT)
  })

  it('an interrupted fresh install retries the platform steps', async () => {
    const { fake, db } = await newOpenDb()
    const { kv, store } = createFakeKV()
    fake.failExecuteMatching(/CREATE TABLE IF NOT EXISTS memory\.insight/, new Error('injected'))
    await expect(ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })).rejects.toThrow()
    expect(store.get(PLATFORM_KEY)).toBe(0)

    fake.clearExecuteMatchFailure()
    fake.calls.length = 0
    await ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })

    expect(store.get(PLATFORM_KEY)).toBe(2)
    expect(fake.calls).toHaveLength(PLATFORM_ALL_COUNT)
  })

  it('a fresh install runs the platform steps itself, after the health ledger', async () => {
    const { fake, db } = await newOpenDb()
    const { kv, store } = createFakeKV()

    await ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })

    expect(store.get(PLATFORM_KEY)).toBe(2)
    const firstPlatform = fake.calls.findIndex(c => c.sql.includes('CREATE TABLE IF NOT EXISTS memory.insight'))
    expect(firstPlatform).toBe(HEALTH_BASELINE_COUNT + HEALTH_UPGRADE_COUNT)
  })
})
