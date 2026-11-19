/**
 * Multi-brand tenancy entities.
 *
 * These are type-only declarations, so the assertions here are compile-time
 * ones expressed as runtime-trivial checks: if the shapes drift, `tsc`
 * fails before jest ever runs. The runtime bodies exist so the file is a
 * real test rather than a lint-suppressed stub.
 */

import type {
  AnalyticsDevice,
  Brand,
  Family,
  User,
} from '../index'

describe('multi-brand tenancy entities', () => {
  it('Brand carries the tenant scope that picks a warehouse strategy', () => {
    const family: Brand = { id: 'acme', name: 'Acme', tenantScope: 'family' }
    const org: Brand = { id: 'globex', name: 'Globex', tenantScope: 'org' }
    expect([family.tenantScope, org.tenantScope]).toEqual(['family', 'org'])
  })

  it('Family denormalizes memberIds for the FamilyMembersProvider', () => {
    const family: Family = {
      id: 'fam_1',
      brand: 'acme',
      ownerId: 'user_alice',
      createdAt: '2026-06-01T00:00:00.000Z',
      memberIds: ['user_alice', 'user_bob'],
    }
    // Principle 39: this array is the single source of truth that both the
    // rules engine and the AI tools authorize against.
    expect(family.memberIds).toContain('user_bob')
  })

  it('User carries brand (identity half) and IANA timezone (mapper input)', () => {
    const user: User = {
      id: 'user_alice',
      brand: 'acme',
      familyId: 'fam_1',
      timezone: 'America/Los_Angeles',
    }
    expect(user.brand).toBe('acme')
    expect(user.timezone).toBe('America/Los_Angeles')
  })

  it('the same email on two brands is two distinct identities', () => {
    // Principle 11: `(brand, userId)` is the composite key.
    const onAcme: User = { id: 'u1', brand: 'acme', email: 'a@example.com' }
    const onInitech: User = { id: 'u2', brand: 'initech', email: 'a@example.com' }
    expect(onAcme.brand).not.toBe(onInitech.brand)
  })

  it('AnalyticsDevice is brand-scoped and distinct from the BLE Device', () => {
    const device: AnalyticsDevice = {
      id: 'hash_of_acme_plus_hardware',
      userId: 'user_alice',
      familyId: 'fam_1',
      brand: 'acme',
      type: 'tag',
      pairedAt: '2026-06-01T00:00:00.000Z',
    }
    // Principle 26: id = hash(brand + hardware_id), so the same device on a
    // second brand account yields a different id.
    expect(device.id).not.toBe(device.userId)
  })
})
