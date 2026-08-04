/**
 * Sprint 3 precondition surface — multi-brand tenancy + cross-package
 * data-plane contracts.
 *
 * These are type-only declarations, so the assertions here are compile-time
 * ones expressed as runtime-trivial checks: if the shapes drift, `tsc`
 * fails before jest ever runs. The runtime bodies exist so the file is a
 * real test rather than a lint-suppressed stub.
 */

import type {
  AnalyticsDevice,
  Brand,
  EventBus,
  Family,
  FirmwareExport,
  MapperContext,
  SensorSink,
  User,
} from '../index'

describe('multi-brand tenancy entities', () => {
  it('Brand carries the tenant scope that picks a warehouse strategy', () => {
    const family: Brand = { id: 'ziva', name: 'ZivaOne', tenantScope: 'family' }
    const org: Brand = { id: 'luminx', name: 'LuminX', tenantScope: 'org' }
    expect([family.tenantScope, org.tenantScope]).toEqual(['family', 'org'])
  })

  it('Family denormalizes memberIds for the FamilyMembersProvider', () => {
    const family: Family = {
      id: 'fam_1',
      brand: 'ziva',
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
      brand: 'ziva',
      familyId: 'fam_1',
      timezone: 'America/Los_Angeles',
    }
    expect(user.brand).toBe('ziva')
    expect(user.timezone).toBe('America/Los_Angeles')
  })

  it('the same email on two brands is two distinct identities', () => {
    // Principle 11: `(brand, userId)` is the composite key.
    const onZiva: User = { id: 'u1', brand: 'ziva', email: 'a@example.com' }
    const onViva: User = { id: 'u2', brand: 'viva', email: 'a@example.com' }
    expect(onZiva.brand).not.toBe(onViva.brand)
  })

  it('AnalyticsDevice is brand-scoped and distinct from the BLE Device', () => {
    const device: AnalyticsDevice = {
      id: 'hash_of_ziva_plus_hardware',
      userId: 'user_alice',
      familyId: 'fam_1',
      brand: 'ziva',
      type: 'ring',
      pairedAt: '2026-06-01T00:00:00.000Z',
    }
    // Principle 26: id = hash(brand + hardware_id), so the same ring on a
    // second brand account yields a different id.
    expect(device.id).not.toBe(device.userId)
  })
})

describe('cross-package data-plane contracts', () => {
  it('FirmwareExport keeps firmware-native naming (principle 20)', () => {
    const fw: FirmwareExport = {
      heartrate: [{ timestamp: '2026.06.18 05:00:00', singleHR: 62 }],
      hrv_table: [{ timestamp: '2026.06.18 05:00:00', hrv: 45, stress: 30 }],
      spo2: [{ timestamp: '2026.06.18 05:00:00', automaticSpo2Data: 97 }],
      temperature_table: [{ timestamp: '2026.06.18 05:00:00', temperature: 36 }],
      activitydetails: [
        {
          timestamp: '2026.06.18 05:00:00',
          step: 45,
          calories: 5,
          distance: 0.03,
          arraySteps: [4, 5, 4, 5, 4, 5, 4, 5, 4, 5],
        },
      ],
      sleep_processed: [
        {
          start: '2026.06.18 05:00:00',
          end: '2026.06.18 12:00:00',
          block_type: 'primary',
          confidence: 0.9,
          timestamp: '2026.06.18 05:00:00',
        },
      ],
      battery_table: [{ timestamp: '2026.06.18 05:00:00', battery: 82 }],
      ring: { automaticMonitoringData: [] },
    }
    // These names are the firmware's, not ours — they must never appear as
    // warehouse columns.
    expect(fw.heartrate[0].singleHR).toBe(62)
    expect(fw.spo2[0].automaticSpo2Data).toBe(97)
  })

  it('MapperContext requires a timezone — night_of is wrong without one', () => {
    const ctx: MapperContext = {
      brand: 'ziva',
      familyId: 'fam_1',
      userId: 'user_alice',
      deviceId: 'ring_8047',
      userTimezone: 'Pacific/Auckland',
    }
    expect(ctx.userTimezone).toBe('Pacific/Auckland')
  })

  it('SensorSink is structurally implementable without importing analytics', () => {
    const calls: string[] = []
    const sink: SensorSink = {
      async push() { calls.push('push') },
      async pushFirmware() { calls.push('pushFirmware') },
      async flush() { calls.push('flush'); return [] },
      async pendingRowCount() { return 0 },
      async clear() { calls.push('clear') },
    }
    expect(typeof sink.pushFirmware).toBe('function')
  })

  it('EventBus contract exposes exact + glob subscription', () => {
    const handlers = new Map<string, (payload: unknown) => void>()
    const bus: EventBus = {
      emit(name, payload) { handlers.get(name)?.(payload) },
      subscribe(name, handler) {
        handlers.set(name, handler as (p: unknown) => void)
        return () => handlers.delete(name)
      },
      subscribePattern() { return () => {} },
    }
    let seen: unknown
    const off = bus.subscribe<{ table: string }>('spo2:insert', (p) => { seen = p })
    bus.emit('spo2:insert', { table: 'spo2' })
    expect(seen).toEqual({ table: 'spo2' })
    off()
  })
})
