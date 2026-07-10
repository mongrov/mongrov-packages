import { describe, expect, it } from 'vitest'

import { HybridDuckDB } from '../engine'
import type { AttachContext } from '../types'
import {
  attachWarehouse,
  detachWarehouse,
  warehouseSecretName,
} from '../warehouse'

import { createFakeAttachDeps } from './__fakes__/fake-attach-deps'
import { createFakeDuckDB } from './__fakes__/fake-duckdb'

async function newOpenDb() {
  const fake = createFakeDuckDB()
  const db = new HybridDuckDB(fake.factory)
  await db.open()
  return { fake, db }
}

const familyCtx: AttachContext = {
  brand: 'brandA',
  tenantScope: 'family',
  tenantId: 'fam123',
  userId: 'user-1',
}

const orgCtx: AttachContext = {
  brand: 'brandA',
  tenantScope: 'org',
  tenantId: 'org456',
  userId: 'user-1',
}

describe('attachWarehouse', () => {
  it('runs builder → token → CREATE SECRET → ATTACH in order', async () => {
    const { fake, db } = await newOpenDb()
    const deps = createFakeAttachDeps({
      uri: 's3://mongrov-analytics/brandA/fam123/warehouse',
    })

    const result = await attachWarehouse(db, familyCtx, deps.deps)

    expect(deps.builderCalls).toEqual([
      { brand: 'brandA', tenantScope: 'family', tenantId: 'fam123' },
    ])
    expect(deps.tokenCalls).toEqual([
      { brand: 'brandA', tenantScope: 'family', tenantId: 'fam123' },
    ])

    expect(fake.calls.map(c => c.sql)).toEqual([
      'CREATE OR REPLACE SECRET zone_fam123 (TYPE ICEBERG, TOKEN $token, ENDPOINT $endpoint);',
      `ATTACH 's3://mongrov-analytics/brandA/fam123/warehouse' AS zone_fam123 (TYPE ICEBERG);`,
    ])
    expect(fake.calls[0].params).toEqual({
      token: 'fake-bearer-token',
      endpoint: 'https://catalog.example/iceberg',
    })
    expect(result.warehouseSecret).toBe('zone_fam123')
    expect(result.warehouseUri).toBe('s3://mongrov-analytics/brandA/fam123/warehouse')
    expect(result.tokenExpiresAt).toBeInstanceOf(Date)
  })

  it('pulls familyMembersProvider only for family scope', async () => {
    const { db } = await newOpenDb()
    const deps = createFakeAttachDeps({ familyMemberIds: ['a', 'b', 'c'] })

    const result = await attachWarehouse(db, familyCtx, deps.deps)

    expect(deps.familyCalls).toEqual([
      { brand: 'brandA', familyId: 'fam123' },
    ])
    expect(result.familyMemberIds).toEqual(['a', 'b', 'c'])
  })

  it('skips familyMembersProvider for org scope', async () => {
    const { db } = await newOpenDb()
    const deps = createFakeAttachDeps()

    const result = await attachWarehouse(db, orgCtx, deps.deps)

    expect(deps.familyCalls).toEqual([])
    expect(result.familyMemberIds).toBeUndefined()
    expect(result.warehouseSecret).toBe('zone_org456')
  })

  it('maps warehouseUriBuilder failure to attach_failed', async () => {
    const { db } = await newOpenDb()
    const deps = createFakeAttachDeps()
    const cause = new Error('bad brand')
    deps.failBuilder(cause)

    await expect(attachWarehouse(db, familyCtx, deps.deps)).rejects.toMatchObject({
      code: 'attach_failed',
      cause,
      message: expect.stringContaining('warehouseUriBuilder'),
    })
  })

  it('maps tokenVendor failure to token_vendor_failed', async () => {
    const { db } = await newOpenDb()
    const deps = createFakeAttachDeps()
    const cause = new Error('vendor down')
    deps.failToken(cause)

    await expect(attachWarehouse(db, familyCtx, deps.deps)).rejects.toMatchObject({
      code: 'token_vendor_failed',
      cause,
    })
  })

  it('maps CREATE SECRET failure to attach_failed with phase in message', async () => {
    const { fake, db } = await newOpenDb()
    const deps = createFakeAttachDeps()
    const cause = new Error('secret rejected')
    fake.failNextExecute(cause)

    await expect(attachWarehouse(db, familyCtx, deps.deps)).rejects.toMatchObject({
      code: 'attach_failed',
      cause,
      message: expect.stringContaining('CREATE SECRET'),
    })
  })

  it('maps familyMembersProvider failure to attach_failed', async () => {
    const { db } = await newOpenDb()
    const deps = createFakeAttachDeps()
    const cause = new Error('no such family')
    deps.failFamily(cause)

    await expect(attachWarehouse(db, familyCtx, deps.deps)).rejects.toMatchObject({
      code: 'attach_failed',
      cause,
      message: expect.stringContaining('familyMembersProvider'),
    })
  })
})

describe('detachWarehouse', () => {
  it('issues DETACH + DROP SECRET in order', async () => {
    const { fake, db } = await newOpenDb()

    await detachWarehouse(db, 'fam123')

    expect(fake.calls.map(c => c.sql)).toEqual([
      'DETACH zone_fam123;',
      'DROP SECRET zone_fam123;',
    ])
  })

  it('maps DETACH failure to detach_failed', async () => {
    const { fake, db } = await newOpenDb()
    const cause = new Error('no such catalog')
    fake.failNextExecute(cause)

    await expect(detachWarehouse(db, 'fam123')).rejects.toMatchObject({
      code: 'detach_failed',
      cause,
    })
  })
})

describe('warehouseSecretName', () => {
  it('prefixes zone_ and passes through valid identifiers', () => {
    expect(warehouseSecretName('fam123')).toBe('zone_fam123')
  })

  it('sanitises non-identifier characters', () => {
    expect(warehouseSecretName('fam-123.xyz')).toBe('zone_fam_123_xyz')
  })
})
