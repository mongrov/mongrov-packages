/**
 * Names a pack claims are unique across packs — tables, ingest adapters,
 * rule contexts and tools — and a collision throws at registration, the
 * platform pack included. Before, an ingest adapter or rule context
 * resolved to the first pack that declared it and a tool to the last,
 * silently. `setDefaultPacks` validates its packs the same way.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DEFAULT_PACKS } from '../../__tests__/packs'
import { AnalyticsError } from '../errors'
import { getPacks, registerPack, resetPacks, setDefaultPacks } from '../packs'

const adapter = { ingest: async () => [] }
const tool = { description: 'd', inputSchema: z.object({}), impl: async () => 'x' } as never
const join = () => ''

afterEach(() => {
  setDefaultPacks(DEFAULT_PACKS)
  resetPacks()
})

describe('registerPack — name collisions throw', () => {
  it('an ingest adapter another pack declares', () => {
    registerPack({ name: 'alpha', ingest: { station: adapter } })
    expect(() => registerPack({ name: 'beta', ingest: { station: adapter } }))
      .toThrow(/ingest adapter "station" is already owned by pack alpha/)
  })

  it('a rule context another pack declares', () => {
    registerPack({ name: 'alpha', rules: { contexts: { daytime: join } } })
    expect(() => registerPack({ name: 'beta', rules: { contexts: { daytime: join } } }))
      .toThrow(/rule context "daytime" is already owned by pack alpha/)
  })

  it('the engine-reserved rule context `any`', () => {
    expect(() => registerPack({ name: 'alpha', rules: { contexts: { any: join } } }))
      .toThrow(/rule context "any" is reserved/)
  })

  it('a tool another pack declares', () => {
    registerPack({ name: 'alpha', tools: { recentWind: tool } })
    expect(() => registerPack({ name: 'beta', tools: { recentWind: tool } }))
      .toThrow(/tool "recentWind" is already owned by pack alpha/)
  })

  it('a tool the platform declares (a pack cannot override it)', () => {
    expect(() => registerPack({ name: 'alpha', tools: { getInsights: tool } }))
      .toThrow(/tool "getInsights" is already owned by pack platform/)
  })

  it('the same names in different kinds do not collide; replacing a pack under its own name is allowed', () => {
    registerPack({ name: 'alpha', ingest: { station: adapter }, tools: { station: tool } })
    registerPack({ name: 'beta', rules: { contexts: { station: join } } })
    registerPack({ name: 'alpha', ingest: { station: adapter } })
    expect(getPacks().map(p => p.name)).toContain('alpha')
  })

  it('a rejected pack is not registered', () => {
    registerPack({ name: 'alpha', tools: { recentWind: tool } })
    expect(() => registerPack({ name: 'beta', tools: { recentWind: tool } })).toThrow(AnalyticsError)
    expect(getPacks().map(p => p.name)).not.toContain('beta')
  })
})

describe('setDefaultPacks — validated like registerPack', () => {
  it('rejects a malformed pack (definePack)', () => {
    expect(() => setDefaultPacks([{ name: 'Bad' }])).toThrow(/name must match/)
  })

  it('rejects the reserved platform name and a name listed twice', () => {
    expect(() => setDefaultPacks([{ name: 'platform' }])).toThrow(/reserved/)
    expect(() => setDefaultPacks([{ name: 'alpha' }, { name: 'alpha' }])).toThrow(/listed twice/)
  })

  it('rejects a collision between defaults, or with the platform', () => {
    expect(() => setDefaultPacks([
      { name: 'alpha', ingest: { station: adapter } },
      { name: 'beta', ingest: { station: adapter } },
    ])).toThrow(/ingest adapter "station" is already owned by pack alpha/)
    expect(() => setDefaultPacks([{ name: 'alpha', tools: { getInsights: tool } }]))
      .toThrow(/already owned by pack platform/)
  })

  it('accepts valid defaults', () => {
    setDefaultPacks([{ name: 'alpha', ingest: { station: adapter } }])
    expect(getPacks().map(p => p.name)).toEqual(['alpha', 'platform'])
  })
})
