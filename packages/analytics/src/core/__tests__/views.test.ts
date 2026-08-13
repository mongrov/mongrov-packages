/**
 * Sprint 5 T-05 / T-06 — `v_{table}` union view DDL + lifecycle.
 *
 * The view is what makes freshness honest (principle 19): rows flushed
 * locally but not yet pushed live only in the local catalog, while pushed
 * rows exist in both. The push watermark partitions the two so the union
 * is complete with no duplicates.
 */

import { describe, expect, it } from 'vitest'

import { HybridDuckDB } from '../engine'
import {
  dropViewDdl,
  generateViewDdl,
  VIEWED_TABLES,
  watermarkColumnFor,
} from '../schemas'
import { createViews, dropViews } from '../warehouse'

import { createFakeDuckDB } from './__fakes__/fake-duckdb'

const CTX = {
  brand: 'ziva',
  familyId: 'fam123',
  localCatalog: 'memory',
  remoteCatalog: 'zone_fam123',
}

async function newOpenDb() {
  const fake = createFakeDuckDB()
  const db = new HybridDuckDB(fake.factory)
  await db.open()
  return { fake, db }
}

describe('VIEWED_TABLES', () => {
  it('covers the sensor tables the registry reads, and no internal ones', () => {
    expect([...VIEWED_TABLES]).toEqual([
      'hrv',
      'heart_rate',
      'spo2',
      'temperature',
      'activity',
      'activity_bucket',
      'sleep_session',
      'sleep_stage',
      'device_event',
      'device_battery',
    ])
    // Internal + local-authoritative tables must NOT be unioned: a remote
    // copy is either absent or non-authoritative, so a union would
    // duplicate or mislead.
    for (const internal of ['insight', 'sync_watermark', 'tool_call_audit', 'user_baseline', 'device_config']) {
      expect(VIEWED_TABLES as readonly string[]).not.toContain(internal)
    }
  })

  it('partitions sleep_session on ts_start, everything else on ts', () => {
    expect(watermarkColumnFor('sleep_session')).toBe('ts_start')
    for (const table of VIEWED_TABLES) {
      if (table === 'sleep_session')
        continue
      expect(watermarkColumnFor(table)).toBe('ts')
    }
  })
})

describe('generateViewDdl', () => {
  it('unions local-after-watermark with the full remote table', () => {
    const sql = generateViewDdl('spo2', CTX)

    expect(sql).toContain('CREATE OR REPLACE VIEW v_spo2 AS')
    expect(sql).toContain('SELECT * FROM memory.spo2')
    expect(sql).toContain('UNION ALL')
    expect(sql).toContain('SELECT * FROM zone_fam123.default.spo2')
    // Local side is filtered strictly AFTER the watermark; remote side is
    // unfiltered. That's what makes the boundary duplicate-free.
    expect(sql).toContain('WHERE ts >')
    expect(sql).toContain(`table_name = 'spo2'`)
    expect(sql).toContain(`kind = 'push'`)
  })

  it('falls back to epoch when no watermark row exists', () => {
    // A fresh install has pushed nothing, so every local row must be
    // visible — COALESCE to 1970 makes `ts > watermark` universally true.
    expect(generateViewDdl('hrv', CTX)).toContain(`'1970-01-01'::TIMESTAMP`)
  })

  it('uses ts_start for sleep_session', () => {
    const sql = generateViewDdl('sleep_session', CTX)
    expect(sql).toContain('WHERE ts_start >')
    expect(sql).not.toContain('WHERE ts >')
  })

  it('scopes the watermark lookup to the attach tenant', () => {
    const sql = generateViewDdl('spo2', CTX)
    expect(sql).toContain(`brand = 'ziva'`)
    expect(sql).toContain(`family_id = 'fam123'`)
  })

  it('escapes quotes in tenant values — view bodies cannot bind params', () => {
    const sql = generateViewDdl('spo2', {
      ...CTX,
      familyId: 'fam\'; DROP TABLE spo2; --',
    })
    // The quote is doubled, so the injection collapses into a single
    // string literal rather than terminating it.
    expect(sql).toContain(`family_id = 'fam''; DROP TABLE spo2; --'`)
    expect(sql).not.toContain(`family_id = 'fam'; DROP`)
  })

  it('emits a local-only view with no UNION in local mode', () => {
    const sql = generateViewDdl('spo2', {
      brand: 'ziva',
      familyId: 'fam123',
      localCatalog: 'memory',
    })
    expect(sql).toBe('CREATE OR REPLACE VIEW v_spo2 AS SELECT * FROM memory.spo2;')
    // Nothing is ever pushed in local mode, so filtering on a watermark
    // that never advances would only cost a scan.
    expect(sql).not.toContain('UNION')
    expect(sql).not.toContain('sync_watermark')
  })

  it('produces valid-looking DDL for every viewed table', () => {
    for (const table of VIEWED_TABLES) {
      const sql = generateViewDdl(table, CTX)
      expect(sql.startsWith(`CREATE OR REPLACE VIEW v_${table} AS`)).toBe(true)
      expect(sql.trimEnd().endsWith(';')).toBe(true)
    }
  })
})

describe('dropViewDdl', () => {
  it('is idempotent by construction', () => {
    expect(dropViewDdl('spo2')).toBe('DROP VIEW IF EXISTS v_spo2;')
  })
})

describe('view lifecycle', () => {
  it('createViews issues one CREATE per viewed table', async () => {
    const { fake, db } = await newOpenDb()
    await createViews(db, CTX)

    const creates = fake.calls.filter(c => c.sql.includes('CREATE OR REPLACE VIEW'))
    expect(creates).toHaveLength(VIEWED_TABLES.length)
    expect(creates[0].sql).toContain('v_hrv')
  })

  it('dropViews issues one DROP per viewed table', async () => {
    const { fake, db } = await newOpenDb()
    await dropViews(db)

    const drops = fake.calls.filter(c => c.sql.includes('DROP VIEW IF EXISTS'))
    expect(drops).toHaveLength(VIEWED_TABLES.length)
  })

  it('createViews surfaces a failure as attach_failed with the view name', async () => {
    const { fake, db } = await newOpenDb()
    const original = fake.instance.execute
    fake.instance.execute = async (sql, params) => {
      if (sql.includes('v_spo2'))
        throw new Error('table spo2 does not exist')
      return original.call(fake.instance, sql, params)
    }

    await expect(createViews(db, CTX)).rejects.toMatchObject({
      code: 'attach_failed',
      message: expect.stringContaining('v_spo2'),
    })
  })

  it('dropViews is best-effort — a failing DROP cannot strand detach', async () => {
    // If the catalog is already unreachable, that is the state detach was
    // aiming for; throwing here would leave the machine in `detaching`.
    const { fake, db } = await newOpenDb()
    fake.instance.execute = async () => {
      throw new Error('catalog zone_fam123 does not exist')
    }

    await expect(dropViews(db)).resolves.toBeUndefined()
  })
})
