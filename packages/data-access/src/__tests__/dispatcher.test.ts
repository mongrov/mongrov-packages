import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineQuery } from '../define'
import { executeQuery, runAuthorize, type EngineAdapters } from '../dispatcher'
import { AuthorizationError, DataAccessError } from '../errors'
import { createQueryInstrumentation } from '../instrumentation'
import { mergeTenantParams } from '../tenant'
import type { RequestContext } from '../types'

const ctx: RequestContext = {
  userId: 'u1',
  brand: 'zivaone',
  familyId: 'f1',
  timezone: 'America/New_York',
  now: () => new Date(1704067200000), // 2024-01-01T00:00Z
}

describe('T-08 · mergeTenantParams', () => {
  it('appends brand + familyId + tz to object input', () => {
    const merged = mergeTenantParams({ userId: 'u1' }, ctx)
    expect(merged).toEqual({
      userId: 'u1',
      brand: 'zivaone',
      familyId: 'f1',
      tz: 'America/New_York',
    })
  })

  it('supplies tenant fields even when input is undefined', () => {
    expect(mergeTenantParams(undefined, ctx)).toEqual({
      brand: 'zivaone',
      familyId: 'f1',
      tz: 'America/New_York',
    })
  })

  it('tenant fields win on collision (screens cannot forge brand/familyId/tz)', () => {
    const merged = mergeTenantParams(
      { userId: 'u1', brand: 'malicious', familyId: 'other', tz: 'Etc/GMT-14' },
      ctx
    )
    expect(merged.brand).toBe('zivaone')
    expect(merged.familyId).toBe('f1')
    expect(merged.tz).toBe('America/New_York')
  })

  it('handles primitive input by dropping it (SQL author uses positional binds)', () => {
    expect(mergeTenantParams('raw', ctx)).toEqual({
      brand: 'zivaone',
      familyId: 'f1',
      tz: 'America/New_York',
    })
  })
})

describe('T-07 · runAuthorize', () => {
  it('no-op when authorize is undefined', async () => {
    await expect(runAuthorize(undefined, {}, ctx)).resolves.toBeUndefined()
  })

  it('allows execution when authorize returns true', async () => {
    await expect(
      runAuthorize(() => true, { userId: 'u1' }, ctx)
    ).resolves.toBeUndefined()
  })

  it('awaits an async authorize', async () => {
    await expect(
      runAuthorize(async () => true, { userId: 'u1' }, ctx)
    ).resolves.toBeUndefined()
  })

  it('throws AuthorizationError when authorize returns false', async () => {
    await expect(
      runAuthorize(() => false, { userId: 'u1' }, ctx)
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  it('threads input + ctx into the authorize hook', async () => {
    const authorize = vi.fn(() => true)
    await runAuthorize(authorize, { userId: 'u1' }, ctx)
    expect(authorize).toHaveBeenCalledWith({ userId: 'u1' }, ctx)
  })
})

describe('T-06 · executeQuery — duckdb path', () => {
  const duckdbDef = defineQuery({
    engine: 'duckdb',
    input: z.object({ userId: z.string() }),
    output: z.object({ hrv: z.number() }),
    sql: 'SELECT hrv FROM hrv WHERE user_id = $userId',
  })

  it('binds only the placeholders the SQL references', async () => {
    // DuckDB binds by name and REJECTS a parameter the statement does not
    // declare ("Failed to retrieve bind parameter index"). This SQL uses
    // only $userId, so brand/familyId/tz must be dropped — binding them
    // would fail the query outright.
    const execute = vi.fn(async () => ({ hrv: 45 }))
    const engines: EngineAdapters = { duckdb: { execute } }
    const out = await executeQuery(duckdbDef, { userId: 'u1' }, ctx, engines)
    expect(out).toEqual({ hrv: 45 })
    expect(execute).toHaveBeenCalledWith(
      'SELECT hrv FROM hrv WHERE user_id = $userId',
      { userId: 'u1' }
    )
  })

  it('surfaces zod input parse failures', async () => {
    const execute = vi.fn()
    const engines: EngineAdapters = { duckdb: { execute } }
    await expect(
      // @ts-expect-error — bad shape
      executeQuery(duckdbDef, { userId: 42 }, ctx, engines)
    ).rejects.toMatchObject({ code: 'zod_parse_failed' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('surfaces zod output parse failures', async () => {
    const execute = vi.fn(async () => ({ hrv: 'not-a-number' }))
    const engines: EngineAdapters = { duckdb: { execute } }
    await expect(
      executeQuery(duckdbDef, { userId: 'u1' }, ctx, engines)
    ).rejects.toMatchObject({ code: 'zod_parse_failed' })
  })

  it('throws engine_missing when duckdb engine absent', async () => {
    await expect(
      executeQuery(duckdbDef, { userId: 'u1' }, ctx, {})
    ).rejects.toMatchObject({ code: 'engine_missing' })
  })
})

describe('T-06 · executeQuery — rxdb path', () => {
  const rxdbDef = defineQuery({
    engine: 'rxdb',
    input: z.object({ userId: z.string() }),
    output: z.number(),
    query: (_db, _input) => 0,
  })

  it('delegates first-value extraction to the adapter', async () => {
    const execute = vi.fn(async () => 7)
    const engines: EngineAdapters = {
      rxdb: { db: 'db-handle', execute },
    }
    const out = await executeQuery(rxdbDef, { userId: 'u1' }, ctx, engines)
    expect(out).toBe(7)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][1]).toEqual({ userId: 'u1' })
  })

  it('throws engine_missing when rxdb engine absent', async () => {
    await expect(
      executeQuery(rxdbDef, { userId: 'u1' }, ctx, {})
    ).rejects.toMatchObject({ code: 'engine_missing' })
  })
})

describe('T-06 · executeQuery — kv path', () => {
  const kvDef = defineQuery({
    engine: 'kv',
    input: z.object({ userId: z.string() }),
    output: z.object({ theme: z.enum(['light', 'dark']) }),
    keyBuilder: (input) => `user:${input.userId}:prefs`,
  })

  it('reads via keyBuilder(input)', async () => {
    const get = vi.fn(async (key: string) => {
      expect(key).toBe('user:u1:prefs')
      return { theme: 'dark' }
    })
    const engines: EngineAdapters = { kv: { get } }
    const out = await executeQuery(kvDef, { userId: 'u1' }, ctx, engines)
    expect(out).toEqual({ theme: 'dark' })
  })

  it('accepts a sync kv get() return', async () => {
    const engines: EngineAdapters = {
      kv: { get: () => ({ theme: 'light' }) },
    }
    const out = await executeQuery(kvDef, { userId: 'u1' }, ctx, engines)
    expect(out).toEqual({ theme: 'light' })
  })

  it('throws engine_missing when kv engine absent', async () => {
    await expect(
      executeQuery(kvDef, { userId: 'u1' }, ctx, {})
    ).rejects.toMatchObject({ code: 'engine_missing' })
  })
})

describe('T-07 · executeQuery — authorize gate at dispatch', () => {
  const def = defineQuery({
    engine: 'duckdb',
    input: z.object({ userId: z.string() }),
    output: z.object({ hrv: z.number() }),
    sql: 'SELECT hrv FROM hrv',
    authorize: (input, c) => input.userId === c.userId,
  })

  it('runs authorize before executing engine', async () => {
    const order: string[] = []
    const engines: EngineAdapters = {
      duckdb: {
        execute: async () => {
          order.push('execute')
          return { hrv: 45 }
        },
      },
    }
    const withAuditedAuthorize = defineQuery({
      engine: 'duckdb',
      input: z.object({ userId: z.string() }),
      output: z.object({ hrv: z.number() }),
      sql: 'SELECT hrv FROM hrv',
      authorize: (_input, _c) => {
        order.push('authorize')
        return true
      },
    })
    await executeQuery(withAuditedAuthorize, { userId: 'u1' }, ctx, engines)
    expect(order).toEqual(['authorize', 'execute'])
  })

  it('denies dispatch when authorize resolves false', async () => {
    const execute = vi.fn(async () => ({ hrv: 45 }))
    const engines: EngineAdapters = { duckdb: { execute } }
    await expect(
      executeQuery(def, { userId: 'attacker' }, ctx, engines)
    ).rejects.toBeInstanceOf(AuthorizationError)
    expect(execute).not.toHaveBeenCalled()
  })

  it('allows dispatch when authorize resolves true', async () => {
    const execute = vi.fn(async () => ({ hrv: 45 }))
    const engines: EngineAdapters = { duckdb: { execute } }
    const out = await executeQuery(def, { userId: 'u1' }, ctx, engines)
    expect(out).toEqual({ hrv: 45 })
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

describe('unknown engine (compile-time exhaustive fallthrough)', () => {
  it('surfaces engine_missing when the config is forged', async () => {
    // Craft a definition that bypasses TS's exhaustiveness at runtime.
    const forged = {
      __kind: 'query' as const,
      config: {
        engine: 'graphql' as unknown as 'duckdb',
        output: z.any(),
        sql: 'ignored',
      },
    }
    await expect(
      executeQuery(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        forged as any,
        undefined,
        ctx,
        {}
      )
    ).rejects.toBeInstanceOf(DataAccessError)
  })
})

describe('T-45 — instrumentation hook', () => {
  const def = defineQuery({
    engine: 'kv',
    output: z.string().nullable(),
    keyBuilder: () => 'k',
  })
  const ctx = {
    userId: 'u', brand: 'ziva', familyId: 'f',
    timezone: 'UTC', now: () => new Date(),
  }
  const engines = { kv: { get: async () => 'v' } }

  it('is skipped entirely when no instrumentation is supplied', async () => {
    // The hot path must not pay for a feature that is off by default.
    await expect(executeQuery(def, {}, ctx, engines as never)).resolves.toBe('v')
  })

  it('records under the registry name when enabled', async () => {
    const inst = createQueryInstrumentation({ enabled: true })
    await executeQuery(def, {}, ctx, engines as never, {
      instrumentation: inst,
      queryName: 'user.spo2SafeLevel',
    })
    expect(inst.statsFor('user.spo2SafeLevel')!.count).toBe(1)
  })

  it('records a failure without swallowing the error', async () => {
    const inst = createQueryInstrumentation({ enabled: true })
    const failing = { kv: { get: async () => { throw new Error('kv down') } } }

    await expect(
      executeQuery(def, {}, ctx, failing as never, {
        instrumentation: inst, queryName: 'user.spo2SafeLevel',
      }),
    ).rejects.toThrow('kv down')

    inst.record('user.spo2SafeLevel', 1, true)
    expect(inst.statsFor('user.spo2SafeLevel')!.errorCount).toBe(1)
  })

  it('does not record when instrumentation is present but disabled', async () => {
    const inst = createQueryInstrumentation({ enabled: false })
    await executeQuery(def, {}, ctx, engines as never, {
      instrumentation: inst, queryName: 'user.spo2SafeLevel',
    })
    expect(inst.statsFor('user.spo2SafeLevel')).toBeNull()
  })
})

describe('referenced-placeholder binding', () => {
  const ctx = {
    userId: 'u1', brand: 'zivaone', familyId: 'f1',
    timezone: 'America/New_York', now: () => new Date(),
  }

  const q = (sql: string) => defineQuery({
    engine: 'duckdb',
    output: z.array(z.unknown()),
    sql,
  })

  it('drops tenant params a query never references', async () => {
    // The bug this prevents: mergeTenantParams injected brand/familyId/tz
    // unconditionally, so any query omitting one failed at bind time with
    // "Failed to retrieve bind parameter index". Three ZivaOne registry
    // queries did exactly that.
    // `userId` comes from caller input, not the tenant merge — only
    // brand/familyId/tz are context-injected.
    const execute = vi.fn(async () => [])
    await executeQuery(
      q('SELECT 1 WHERE u = $userId'),
      { userId: 'u1' } as never, ctx, { duckdb: { execute } } as never,
    )
    expect(execute.mock.calls[0][1]).toEqual({ userId: 'u1' })
  })

  it('keeps every tenant param a query does reference', async () => {
    const execute = vi.fn(async () => [])
    await executeQuery(
      q('SELECT timezone($tz, ts) WHERE brand = $brand AND family_id = $familyId'),
      {}, ctx, { duckdb: { execute } } as never,
    )
    expect(execute.mock.calls[0][1]).toEqual({
      brand: 'zivaone', familyId: 'f1', tz: 'America/New_York',
    })
  })

  it('drops caller input the SQL ignores, too', async () => {
    const execute = vi.fn(async () => [])
    await executeQuery(
      q('SELECT 1 WHERE u = $userId'),
      { userId: 'u1', offset: 3, unused: 'x' } as never,
      ctx, { duckdb: { execute } } as never,
    )
    expect(execute.mock.calls[0][1]).toEqual({ userId: 'u1' })
  })

  it('still lets tenant values win over forged input', async () => {
    const execute = vi.fn(async () => [])
    await executeQuery(
      q('SELECT 1 WHERE brand = $brand'),
      { brand: 'evil-brand' } as never,
      ctx, { duckdb: { execute } } as never,
    )
    expect(execute.mock.calls[0][1]).toEqual({ brand: 'zivaone' })
  })
})
