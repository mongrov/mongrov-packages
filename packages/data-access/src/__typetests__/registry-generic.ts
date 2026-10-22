import type { DataAccessProviderConfig } from '../context'
import type { Registry } from '../types'
/**
 * TYPE-LEVEL tests for mongrov-packages#4 — never executed; `pnpm typecheck`
 * over this file is the test.
 *
 * `Registry` used to type its maps as `Record<string, QueryDefinition<unknown,
 * unknown>>`. A concrete definition's input is invariant (it sits in both
 * function parameters and schema positions), so no real registry was
 * assignable and every consumer double-cast at the provider boundary.
 *
 * This program registers NO registry type (see `__typetests_registered__` for
 * the registered half), so the hooks keep their caller-asserted form here.
 */
import { z } from 'zod'
import { defineMutation, defineQuery } from '../define'
import { createRegistryHooks, useAppMutation, useAppQuery } from '../hooks'

const registry = {
  queries: {
    'spo2.day': defineQuery({
      engine: 'duckdb',
      input: z.object({ userId: z.string(), offset: z.number() }),
      output: z.object({ dayAvg: z.number().nullable() }),
      authorize: input => input.userId.length > 0,
      sql: 'SELECT 1',
    }),
    'user.safeLevel': defineQuery({
      engine: 'kv',
      input: z.object({ userId: z.string() }),
      output: z.number().int(),
      keyBuilder: ({ userId }) => `user:${userId}:safeLevel`,
    }),
  },
  mutations: {
    'insight.dismiss': defineMutation({
      input: z.object({ insightId: z.string() }),
      output: z.object({ ok: z.boolean() }),
      exec: async () => ({ ok: true }),
    }),
  },
  events: {
    'tenant:changed': undefined,
  },
}

// --- a concrete registry needs no cast -------------------------------------

// Bare `Registry` means "any registry" and now accepts a concrete one.
export const bare: Registry = registry

// The generic form keeps the entry types.
export const typed: Registry<typeof registry.queries, typeof registry.mutations> = registry
export type DayEntry = typeof typed.queries['spo2.day']

// The provider prop takes it directly — the boundary that used to need
// `as unknown as Registry`.
export const prop: DataAccessProviderConfig['registry'] = registry

// @ts-expect-error a map value that is not a query definition is still rejected
export const notAQuery: Registry = { queries: { x: { sql: 'SELECT 1' } }, mutations: {}, events: {} }

// --- unregistered: the caller-asserted form is unchanged --------------------

export function useLegacyCallSites(): void {
  // Explicit type arguments and any name, exactly as before.
  const q = useAppQuery<{ a: number }, string>('any.name', { a: 1 })
  const s: string | undefined = q.data
  void s
  const m = useAppMutation<{ id: string }, void>('any.mutation')
  m.mutate({ id: 'x' })
  // Inferred input, unknown output — as before.
  const inferred = useAppQuery('other.name', { b: true })
  const u: unknown = inferred.data
  void u
}

// --- createRegistryHooks grows a typed useAppMutation -----------------------

const hooks = createRegistryHooks<typeof registry.queries, typeof registry.mutations>()

export function useFactoryCallSites(): void {
  const day = hooks.useAppQuery('spo2.day', { userId: 'u', offset: 0 })
  const avg: number | null | undefined = day.data?.dayAvg
  void avg

  const dismiss = hooks.useAppMutation('insight.dismiss')
  dismiss.mutate({ insightId: 'i1' })
  const ok: boolean | undefined = dismiss.data?.ok
  void ok

  // @ts-expect-error `insightId` is required by the mutation's input schema
  dismiss.mutate({})

  // @ts-expect-error not a registered mutation name
  hooks.useAppMutation('insight.undismiss')
}

// The one-argument form still compiles; with no mutation map its typed
// `useAppMutation` accepts no name at all.
const queriesOnly = createRegistryHooks<typeof registry.queries>()
export function useQueriesOnlyCallSites(): void {
  queriesOnly.useAppQuery('user.safeLevel', { userId: 'u' })
  // @ts-expect-error no mutation map was supplied
  queriesOnly.useAppMutation('insight.dismiss')
}
