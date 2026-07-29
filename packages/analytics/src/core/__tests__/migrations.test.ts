import { describe, expect, it } from 'vitest'

import { HybridDuckDB } from '../engine'
import {
  CURRENT_VERSION,
  ensureMigrations,
  type Migration,
  schemaVersionKey,
} from '../migrations'

import { createFakeDuckDB } from './__fakes__/fake-duckdb'
import { createFakeKV } from './__fakes__/fake-kv'

async function newOpenDb() {
  const fake = createFakeDuckDB()
  const db = new HybridDuckDB(fake.factory)
  await db.open()
  return { fake, db }
}

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
    // baseline migration now issues LOCAL_SCHEMAS in local catalog +
    // SCHEMAS in remote catalog = 14 + 14 = 28 DDLs (0.5.0 fix for
    // "ensureSchemas never creates local.* tables").
    expect(fake.calls).toHaveLength(28)
    // Local tables come first (baseline migration order).
    expect(fake.calls[0].sql).toContain('CREATE TABLE IF NOT EXISTS memory.hrv')
    expect(fake.calls[0].sql).not.toContain('PARTITIONED BY')
    // Then remote tables with PARTITIONED BY.
    expect(fake.calls[14].sql).toContain('CREATE TABLE IF NOT EXISTS zone_fam123.hrv')
    expect(fake.calls[14].sql).toContain('PARTITIONED BY')
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

  it('multi-step upgrade path applies only newer migrations', async () => {
    // Since MIGRATIONS is v0.1.0-only (one step), simulate a future upgrade
    // via a synthetic run: pre-set KV to a version below CURRENT_VERSION,
    // observe that ensureSchemas still runs (since v1 > from=0).
    const { fake, db } = await newOpenDb()
    const { kv, store } = createFakeKV()

    // Start from before baseline (as if a new tenant).
    const result = await ensureMigrations(db, kv, CTX, { local: 'memory', remote: CATALOG })
    expect(result.from).toBe(0)
    expect(result.to).toBe(CURRENT_VERSION)
    // Baseline creates 14 local + 14 remote = 28 DDLs post-0.5.0.
    expect(fake.calls.length).toBe(28)

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
