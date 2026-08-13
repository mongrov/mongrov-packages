import type { Migration } from '../migrations'

import { describe, expect, it } from 'vitest'
import { HybridDuckDB } from '../engine'
import {
  CURRENT_VERSION,
  ensureMigrations,

  schemaVersionKey,
} from '../migrations'
import { LOCAL_ONLY_TABLES, TABLE_NAMES } from '../schemas'

import { createFakeDuckDB } from './__fakes__/fake-duckdb'
import { createFakeKV } from './__fakes__/fake-kv'

async function newOpenDb() {
  const fake = createFakeDuckDB()
  const db = new HybridDuckDB(fake.factory)
  await db.open()
  return { fake, db }
}

/**
 * DDL counts the baseline migration issues, derived from TABLE_NAMES so
 * adding a table does not require retuning every count in this file.
 * Local gets every table; remote skips the local-only ones.
 */
const LOCAL_DDL_COUNT = TABLE_NAMES.length
const REMOTE_DDL_COUNT = TABLE_NAMES.length - LOCAL_ONLY_TABLES.size
const BASELINE_DDL_COUNT = LOCAL_DDL_COUNT + REMOTE_DDL_COUNT
/** step-2 re-ensures device_battery in both catalogs. */
const STEP2_COUNT = 2
/**
 * step-3 issues 8 statements: the fake returns no columns for the
 * information_schema probe, so the recreate path runs (probe + drop
 * scratch + create scratch + copy + drop + rename + index + remote).
 */
const STEP3_COUNT = 8
/** step-4 creates user_baseline in the local catalog only. */
const STEP4_COUNT = 1
/**
 * step-5 (device_config data_type -> metric) probes information_schema and
 * returns early on a fresh install, where the baseline already created the
 * new shape. One statement.
 */
const STEP5_COUNT = 1

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
    // baseline issues LOCAL_SCHEMAS in the local catalog + SCHEMAS in the
    // remote catalog (0.5.0 fix for "ensureSchemas never creates local.*
    // tables"), minus the local-only tables remote-side; then steps 2-4.
    expect(fake.calls).toHaveLength(
      BASELINE_DDL_COUNT + STEP2_COUNT + STEP3_COUNT + STEP4_COUNT + STEP5_COUNT,
    )
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
    // Steps 3 + 4 follow (see first-run test).
    expect(fake.calls).toHaveLength(STEP2_COUNT + STEP3_COUNT + STEP4_COUNT + STEP5_COUNT)
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
    // `system` catalog the iOS DuckDB build cannot resolve.
    expect(sqls[0]).toContain('PRAGMA table_info')
    expect(sqls[0]).toContain('insight')
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
    expect(fake.calls.length).toBe(
      BASELINE_DDL_COUNT + STEP2_COUNT + STEP3_COUNT + STEP4_COUNT + STEP5_COUNT,
    )

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
    const { MIGRATIONS } = await import('../migrations')
    expect(CURRENT_VERSION).toBe(MIGRATIONS.length)
    for (let i = 0; i < MIGRATIONS.length; i++) {
      const m = MIGRATIONS[i] as Migration
      expect(m.version).toBe(i + 1)
    }
  })
})
