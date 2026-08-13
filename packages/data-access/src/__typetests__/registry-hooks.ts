import type { QueryInputOf, QueryOutputOf } from '../hooks'

/**
 * TYPE-LEVEL tests. Never executed — `pnpm typecheck` running over this file
 * IS the test, and every `@ts-expect-error` below fails the build if the
 * contract it guards stops holding.
 *
 * They live outside `__tests__` because tsconfig excludes that directory, so
 * assertions placed there are silently never checked.
 *
 * Registry-typed hooks.
 *
 * `useAppQuery<TInput, TOutput>` believes whatever the call site asserts.
 * zivaone_app annotated `user.spo2SafeLevel` as `{ value: number }` when the
 * query returns a bare `number`, read `.data?.value`, got `undefined` forever,
 * and silently fell back to a default of 90. It compiled, never threw, and no
 * test caught it — the shape was asserted, not checked.
 *
 * These are type-level assertions: the value assertions are trivial, and the
 * point is that the WRONG ones would not compile. `tsc` running over this file
 * is the test.
 */
import { z } from 'zod'
import { defineQuery } from '../define'
import { createRegistryHooks } from '../hooks'

const registry = {
  'user.safeLevel': defineQuery({
    engine: 'kv',
    input: z.object({ userId: z.string() }),
    output: z.number().int(),
    keyBuilder: ({ userId }) => `user:${userId}:safeLevel`,
  }),
  'spo2.day': defineQuery({
    engine: 'duckdb',
    input: z.object({ userId: z.string(), offset: z.number() }),
    output: z.object({ dayAvg: z.number().nullable() }),
    sql: 'SELECT 1',
  }),
}

type Queries = typeof registry

// derives the output type from the registry entry
// A bare number — NOT `{ value: number }`, which is what the app guessed.
const out: QueryOutputOf<Queries['user.safeLevel']> = 94

// @ts-expect-error the output is a number, so an object is not assignable
const wrong: QueryOutputOf<Queries['user.safeLevel']> = { value: 94 }

// derives the input type too
const input: QueryInputOf<Queries['spo2.day']> = { userId: 'u1', offset: 0 }

// @ts-expect-error `offset` is required by this query's input schema
const missing: QueryInputOf<Queries['spo2.day']> = { userId: 'u1' }

// distinguishes entries — one shape does not leak into another
const day: QueryOutputOf<Queries['spo2.day']> = { dayAvg: 96 }

// @ts-expect-error spo2.day returns an object, not a number
const asNumber: QueryOutputOf<Queries['spo2.day']> = 96

// A concrete registry map must satisfy createRegistryHooks' constraint.
// The first attempt used `QueryDefinition<never, unknown>`, which a real map
// does NOT extend — the same variance erasure consumers double-cast around —
// so wiring it in an app failed at the call site rather than here.
const hooks = createRegistryHooks<Queries>()
export type DayResult = ReturnType<typeof hooks.useAppQuery<'spo2.day'>>['data']
