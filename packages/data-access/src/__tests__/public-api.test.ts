import type {
  EventDefinition,
  MutationDefinition,
  QueryDefinition,
  RequestContext,
} from '../index'
import { describe, expect, it } from 'vitest'

import { z } from 'zod'
import {
  AuthorizationError,
  DataAccessError,
  defineEvent,
  defineMutation,
  defineQuery,
  NotImplementedError,
} from '../index'

describe('DataAccessError taxonomy', () => {
  it('DataAccessError carries a code', () => {
    const err = new DataAccessError('engine_missing', 'no duckdb engine')
    expect(err.name).toBe('DataAccessError')
    expect(err.code).toBe('engine_missing')
    expect(err.message).toBe('no duckdb engine')
    expect(err).toBeInstanceOf(Error)
  })

  it('AuthorizationError specializes to authorization_denied', () => {
    const err = new AuthorizationError('user not in family')
    expect(err.name).toBe('AuthorizationError')
    expect(err.code).toBe('authorization_denied')
    expect(err).toBeInstanceOf(DataAccessError)
  })

  it('NotImplementedError names the missing symbol', () => {
    const err = new NotImplementedError('useAppQuery')
    expect(err.name).toBe('NotImplementedError')
    expect(err.code).toBe('not_implemented')
    expect(err.message).toContain('useAppQuery')
    expect(err.message).toContain('0.1.0-alpha.0')
  })
})

describe('defineQuery (T-03)', () => {
  it('returns a duckdb query handle with __kind=query', () => {
    const q = defineQuery({
      engine: 'duckdb',
      input: z.object({ userId: z.string() }),
      output: z.object({ n: z.number() }),
      sql: 'SELECT 1 AS n',
    })
    expect(q.__kind).toBe('query')
    expect(q.config.engine).toBe('duckdb')
    expect(q.config.engine === 'duckdb' && q.config.sql).toBe('SELECT 1 AS n')
  })

  it('duckdb engine requires sql', () => {
    expect(() =>
      defineQuery({
        engine: 'duckdb',
        output: z.object({ n: z.number() }),
        // @ts-expect-error — missing sql field
        sql: undefined,
      }),
    ).toThrow(DataAccessError)
  })

  it('duckdb engine rejects empty sql', () => {
    expect(() =>
      defineQuery({
        engine: 'duckdb',
        output: z.object({ n: z.number() }),
        sql: '',
      }),
    ).toThrow(/non-empty `sql`/)
  })

  it('rxdb engine requires a query function', () => {
    expect(() =>
      defineQuery({
        engine: 'rxdb',
        output: z.number(),
        // @ts-expect-error — missing query field
        query: undefined,
      }),
    ).toThrow(/requires a `query` function/)
  })

  it('rxdb engine accepts a query function', () => {
    const q = defineQuery({
      engine: 'rxdb',
      input: z.object({ userId: z.string() }),
      output: z.number(),
      query: (_db, _input) => 0,
    })
    expect(q.__kind).toBe('query')
    expect(q.config.engine).toBe('rxdb')
  })

  it('kv engine requires a keyBuilder function', () => {
    expect(() =>
      defineQuery({
        engine: 'kv',
        output: z.string(),
        // @ts-expect-error — missing keyBuilder field
        keyBuilder: undefined,
      }),
    ).toThrow(/requires a `keyBuilder` function/)
  })

  it('kv engine accepts a keyBuilder function', () => {
    const q = defineQuery({
      engine: 'kv',
      input: z.object({ userId: z.string() }),
      output: z.string(),
      keyBuilder: input => `user:${input.userId}`,
    })
    expect(q.__kind).toBe('query')
    expect(q.config.engine === 'kv' && q.config.keyBuilder({ userId: 'u1' })).toBe(
      'user:u1',
    )
  })
})

describe('defineMutation (T-04)', () => {
  it('returns a mutation handle', () => {
    const m = defineMutation({
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
      exec: async () => ({ ok: true }),
      invalidates: ['hrv:*'],
    })
    expect(m.__kind).toBe('mutation')
    expect(m.config.invalidates).toEqual(['hrv:*'])
  })

  it('requires an exec function', () => {
    expect(() =>
      defineMutation({
        input: z.object({ id: z.string() }),
        // @ts-expect-error — missing exec
        exec: undefined,
      }),
    ).toThrow(/requires an `exec`/)
  })
})

describe('defineEvent (T-05)', () => {
  it('returns an event handle', () => {
    const e = defineEvent<{ table: string, rows: number }>()
    expect(e.__kind).toBe('event')
  })
})

describe('type-surface compile check', () => {
  it('QueryDefinition / MutationDefinition / EventDefinition are exported', () => {
    const _q: QueryDefinition<{ id: string }, number> | undefined = undefined
    const _m: MutationDefinition<{ id: string }, boolean> | undefined
      = undefined
    const _e: EventDefinition<{ ok: true }> | undefined = undefined
    const _ctx: RequestContext | undefined = undefined
    expect(_q).toBeUndefined()
    expect(_m).toBeUndefined()
    expect(_e).toBeUndefined()
    expect(_ctx).toBeUndefined()
  })
})
