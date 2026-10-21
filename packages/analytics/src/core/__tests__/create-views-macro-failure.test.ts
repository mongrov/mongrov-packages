/*
 * A bounded macro that fails to create must not fail attach (zivaone_app#191).
 *
 * Attach gates writes as well as reads: the ring handoff and the sync cursors
 * reject with "execute requires an attached engine" when it errors. So when a
 * macro failed only on the device's DuckDB build, synced ring data could not be
 * stored at all. The macros are a read-side speed-up; losing one must cost the
 * queries that use it, never the writes. Views stay fatal — every read and
 * rule depends on them.
 */
import type { HybridDuckDB } from '../engine'
import { describe, expect, it } from 'vitest'
import { fallbackMacroDdl, qualityMacroDdls } from '../reading-quality'
import { createViews } from '../warehouse'

const ctx = { brand: 'ziva', familyId: 'f', localCatalog: 'memory' }

function fakeDb(failOn: (sql: string) => boolean) {
  const executed: string[] = []
  const db = {
    execute: async (sql: string) => {
      executed.push(sql)
      if (failOn(sql))
        throw new Error('ParameterNotResolvedException')
      return []
    },
  } as unknown as HybridDuckDB
  return { db, executed }
}

const isMacro = (sql: string) => sql.startsWith('CREATE OR REPLACE MACRO')

describe('createViews and a failing macro', () => {
  it('carries on, reports the macro, and still creates every other macro', async () => {
    const failing = qualityMacroDdls()[1]!.name
    // Only the real body fails; its plain fallback creates.
    const { db, executed } = fakeDb(sql => sql.includes(`MACRO ${failing}(`) && sql.includes('WITH _motion'))
    const failures: string[] = []

    await expect(createViews(db, ctx, { onMacroFailed: name => failures.push(name) }))
      .resolves
      .toEqual({ unavailableMacros: [] })

    expect(failures).toEqual([failing])
    // One failure does not stop the loop: every macro was still attempted,
    // plus the failed one's fallback.
    expect(executed.filter(isMacro)).toHaveLength(qualityMacroDdls().length + 1)
  })

  it('installs the plain form under the same name when the real body fails (mongrov-packages#44)', async () => {
    const failing = qualityMacroDdls()[1]!.name
    const { db, executed } = fakeDb(sql => sql.includes(`MACRO ${failing}(`) && sql.includes('WITH _motion'))
    await createViews(db, ctx)
    const fallback = fallbackMacroDdl(failing)
    expect(executed).toContain(fallback)
    expect(fallback).toContain(`FROM ${failing.replace(/_between$/, '')} WHERE`)
  })

  it('reports a macro unavailable only when its fallback fails too', async () => {
    const failing = qualityMacroDdls()[1]!.name
    const { db } = fakeDb(sql => sql.includes(`MACRO ${failing}(`))
    await expect(createViews(db, ctx)).resolves.toEqual({ unavailableMacros: [failing] })
  })

  it('does not throw even with no reporter wired', async () => {
    const { db } = fakeDb(isMacro)
    const result = await createViews(db, ctx)
    expect(result.unavailableMacros).toEqual(qualityMacroDdls().map(m => m.name))
  })

  it('still fails attach when a VIEW fails — those are load-bearing', async () => {
    const { db } = fakeDb(sql => sql.includes('VIEW v_heart_rate_q'))
    await expect(createViews(db, ctx)).rejects.toThrow(/CREATE VIEW v_heart_rate_q failed/)
  })
})
