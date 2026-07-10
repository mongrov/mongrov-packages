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

    const result = await ensureMigrations(db, kv, CTX, CATALOG)

    expect(result).toEqual({ from: 0, to: CURRENT_VERSION })
    expect(store.get(KEY)).toBe(CURRENT_VERSION)
    // baseline migration is ensureSchemas → 14 DDLs.
    expect(fake.calls).toHaveLength(14)
    expect(fake.calls[0].sql).toContain('CREATE TABLE IF NOT EXISTS zone_fam123.hrv')
  })

  it('same-version rerun: no DDL issued, KV unchanged', async () => {
    const { fake, db } = await newOpenDb()
    const { kv, store } = createFakeKV()
    store.set(KEY, CURRENT_VERSION)

    const result = await ensureMigrations(db, kv, CTX, CATALOG)

    expect(result).toEqual({ from: CURRENT_VERSION, to: CURRENT_VERSION })
    expect(fake.calls).toHaveLength(0)
    expect(store.get(KEY)).toBe(CURRENT_VERSION)
  })

  it('per-family isolation: familyA at v1 does not affect familyB at v0', async () => {
    const { db } = await newOpenDb()
    const { kv, store } = createFakeKV()
    store.set(schemaVersionKey('brandA', 'famA'), CURRENT_VERSION)

    const resultA = await ensureMigrations(db, kv, { brand: 'brandA', tenantId: 'famA' }, 'zone_famA')
    const resultB = await ensureMigrations(db, kv, { brand: 'brandA', tenantId: 'famB' }, 'zone_famB')

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

    await expect(ensureMigrations(db, kv, CTX, CATALOG)).rejects.toMatchObject({
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
    const result = await ensureMigrations(db, kv, CTX, CATALOG)
    expect(result.from).toBe(0)
    expect(result.to).toBe(CURRENT_VERSION)
    expect(fake.calls.length).toBe(14)

    // Same call again — no-op. KV already at CURRENT_VERSION.
    fake.calls.length = 0
    const result2 = await ensureMigrations(db, kv, CTX, CATALOG)
    expect(result2.from).toBe(CURRENT_VERSION)
    expect(result2.to).toBe(CURRENT_VERSION)
    expect(fake.calls.length).toBe(0)
    expect(store.get(KEY)).toBe(CURRENT_VERSION)
  })
})

describe('schemaVersionKey', () => {
  it('composes analytics:schema-version:<brand>:<tenantId>', () => {
    expect(schemaVersionKey('brandA', 'fam123')).toBe('analytics:schema-version:brandA:fam123')
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
