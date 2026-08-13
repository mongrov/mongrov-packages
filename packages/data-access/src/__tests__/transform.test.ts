/**
 * `transform` — the post-query derivation hook (data-access spec, Sprint 5+).
 *
 * The spec always specified this as running "AFTER the SQL query, BEFORE Zod
 * output parse", but the shipped 0.2.0 implementation treated the field as
 * inert registry metadata and the dispatcher parsed raw engine rows. That
 * made any query whose declared `output` contained derived fields
 * unsatisfiable by construction — the ZivaOne SpO₂ registry has five such
 * queries, and each would have failed its own schema on first call.
 *
 * These tests pin the contract that resolves it: a callable `transform` is
 * applied between the engine and the parse, so `output` describes the
 * DERIVED shape.
 */

import type { EngineAdapters } from '../dispatcher'
import type { RequestContext } from '../types'

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineQuery } from '../define'
import { executeQuery } from '../dispatcher'
import { DataAccessError } from '../errors'

const ctx: RequestContext = {
  userId: 'u1',
  brand: 'zivaone',
  familyId: 'f1',
  timezone: 'America/New_York',
  now: () => new Date(1704067200000),
}

/** Raw rows in, derived object out — the shape a real registry query has. */
const rawRows = [{ hour: 0, spo2: 96 }, { hour: 1, spo2: 88 }]

function enginesReturning(rows: unknown): EngineAdapters {
  return { duckdb: { execute: vi.fn().mockResolvedValue(rows) } } as never
}

describe('transform runs between the engine and the parse', () => {
  it('lets output describe the derived shape, not the SQL projection', async () => {
    // `verdict` and `low` exist nowhere in the rows the engine returns.
    const def = defineQuery({
      engine: 'duckdb',
      input: z.object({}),
      output: z.object({ verdict: z.enum(['ok', 'watch']), low: z.number() }),
      sql: 'SELECT 1',
      transform: (raw) => {
        const rows = raw as { spo2: number }[]
        const low = Math.min(...rows.map(r => r.spo2))
        return { verdict: low < 90 ? ('watch' as const) : ('ok' as const), low }
      },
    })

    expect(await executeQuery(def, {}, ctx, enginesReturning(rawRows)))
      .toEqual({ verdict: 'watch', low: 88 })
  })

  it('fails the parse without a transform — the pre-0.3.0 bug, pinned', async () => {
    // Same query, transform removed. This is exactly what the shipped
    // ZivaOne registry did, and why it could never have worked.
    const def = defineQuery({
      engine: 'duckdb',
      input: z.object({}),
      output: z.object({ verdict: z.enum(['ok', 'watch']) }),
      sql: 'SELECT 1',
    })

    await expect(executeQuery(def, {}, ctx, enginesReturning(rawRows)))
      .rejects
      .toMatchObject({ code: 'zod_parse_failed' })
  })

  it('receives the request context and the PARSED input', async () => {
    // Derivation needs both: an offset to label the day, a timezone to place
    // it. Parsed, not raw, so a defaulted field is present.
    const seen: { input: { offset: number }, timezone: string }[] = []
    const def = defineQuery({
      engine: 'duckdb',
      input: z.object({ offset: z.number().default(0) }),
      output: z.object({ ok: z.boolean() }),
      sql: 'SELECT 1',
      transform: (_raw, derive) => {
        seen.push(derive as never)
        return { ok: true }
      },
    })

    await executeQuery(def, {} as never, ctx, enginesReturning([]))
    expect(seen[0].input).toEqual({ offset: 0 })
    expect(seen[0].timezone).toBe('America/New_York')
  })

  it('runs after the engine, so it sees real rows', async () => {
    const order: string[] = []
    const engines = {
      duckdb: {
        execute: vi.fn().mockImplementation(async () => {
          order.push('engine')
          return rawRows
        }),
      },
    } as never
    const def = defineQuery({
      engine: 'duckdb',
      input: z.object({}),
      output: z.object({ n: z.number() }),
      sql: 'SELECT 1',
      transform: (raw) => {
        order.push('transform')
        return { n: (raw as unknown[]).length }
      },
    })

    expect(await executeQuery(def, {}, ctx, engines)).toEqual({ n: 2 })
    expect(order).toEqual(['engine', 'transform'])
  })
})

describe('failure modes stay distinguishable', () => {
  it('reports a throwing transform as transform_failed, not a raw throw', async () => {
    // A derivation bug must not read as an engine or schema failure in the
    // hook's `error` — that is the difference between debugging SQL and
    // debugging TypeScript.
    const def = defineQuery({
      engine: 'duckdb',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      sql: 'SELECT 1',
      transform: () => { throw new Error('empty slot array') },
    })

    const err = await executeQuery(def, {}, ctx, enginesReturning([]))
      .catch((e: unknown) => e as DataAccessError)
    expect(err).toBeInstanceOf(DataAccessError)
    expect(err.code).toBe('transform_failed')
    expect(err.message).toContain('empty slot array')
  })

  it('still parses a transform result — derivation is not a bypass', async () => {
    const def = defineQuery({
      engine: 'duckdb',
      input: z.object({}),
      output: z.object({ verdict: z.enum(['ok', 'watch']) }),
      sql: 'SELECT 1',
      transform: () => ({ verdict: 'nonsense' }) as never,
    })

    await expect(executeQuery(def, {}, ctx, enginesReturning([])))
      .rejects
      .toMatchObject({ code: 'zod_parse_failed' })
  })
})

describe('string transform stays accepted and inert', () => {
  it('passes raw rows through, so existing registries keep working', async () => {
    // The original contract said a path string would be "resolved at build
    // time". Nothing resolves it: Metro cannot require an arbitrary runtime
    // path and no build step generates the wiring. Rather than break every
    // registry that declares one, a string is ignored — the query behaves
    // exactly as it did before this feature existed.
    const def = defineQuery({
      engine: 'duckdb',
      input: z.object({}),
      output: z.array(z.object({ hour: z.number(), spo2: z.number() })),
      sql: 'SELECT 1',
      transform: 'apps/zivaone/src/features/spo2/utils/derive-day.ts',
    })

    expect(await executeQuery(def, {}, ctx, enginesReturning(rawRows)))
      .toEqual(rawRows)
  })
})
