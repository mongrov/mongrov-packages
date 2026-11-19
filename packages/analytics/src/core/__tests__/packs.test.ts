import { afterEach, describe, expect, it } from 'vitest'
import { AnalyticsError } from '../errors'
import { definePack, getPacks, packTable, packTables, registerPack, resetPacks, viewedTables } from '../packs'
import { TABLE_NAMES, VIEWED_TABLES } from '../schemas'

const NOTE = {
  ddl: 'CREATE TABLE note (\n  ts TIMESTAMP NOT NULL,\n  brand VARCHAR NOT NULL,\n  body VARCHAR\n);',
  timeColumn: 'ts',
  syncable: false,
  retention: null,
}

afterEach(() => resetPacks())

describe('pack registry', () => {
  it('knows the platform and default packs, platform last, in the pre-pack table order', () => {
    expect(getPacks().map(p => p.name)).toEqual(['health', 'ring', 'platform'])
    expect([...packTables().keys()]).toEqual([...TABLE_NAMES])
    expect(viewedTables()).toEqual([...VIEWED_TABLES])
  })

  it('registers a pack before the platform and finds its tables', () => {
    registerPack({ name: 'notes', tables: { note: NOTE } })
    expect(getPacks().map(p => p.name)).toEqual(['health', 'ring', 'notes', 'platform'])
    expect(packTable('note')?.timeColumn).toBe('ts')
  })

  it('registering the same pack twice is a no-op; a new object under the name replaces it in place', () => {
    const a = { name: 'notes', tables: { note: NOTE } }
    registerPack(a)
    registerPack(a)
    registerPack({ name: 'notes', tables: { note: { ...NOTE, syncable: true } } })
    expect(getPacks().map(p => p.name)).toEqual(['health', 'ring', 'notes', 'platform'])
    expect(packTable('note')?.syncable).toBe(true)
  })

  it('rejects a table another pack owns, and the reserved platform name', () => {
    expect(() => registerPack({ name: 'dup', tables: { insight: { ...NOTE, ddl: NOTE.ddl.replace('note', 'insight') } } }))
      .toThrow(/already owned by pack platform/)
    expect(() => registerPack({ name: 'platform' })).toThrow(AnalyticsError)
  })
})

describe('definePack', () => {
  it('rejects a malformed pack where it is defined', () => {
    expect(() => definePack({ name: 'Bad' })).toThrow(/name must match/)
    expect(() => definePack({ name: 'x', tables: { v_x: NOTE } })).toThrow(/reserved/)
    expect(() => definePack({ name: 'x', tables: { other: NOTE } })).toThrow(/ddl must start/)
    expect(() => definePack({ name: 'x', tables: { note: { ...NOTE, timeColumn: 'nope' } } })).toThrow(/timeColumn/)
    expect(() => definePack({ name: 'x', tables: { note: { ...NOTE, identity: ['nope'] } } })).toThrow(/identity column/)
    expect(() => definePack({ name: 'x', migrations: [{ version: 2, name: 'm', up: async () => {} }] })).toThrow(/expected 1/)
  })
})
