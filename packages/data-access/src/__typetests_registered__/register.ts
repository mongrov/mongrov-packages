/**
 * TYPE-LEVEL tests for mongrov-packages#4, REGISTERED half — never executed.
 *
 * Declaration merging is global to a TypeScript program, so this file has its
 * own program (`tsconfig.typetests-registered.json`, run by `pnpm typecheck`)
 * rather than living beside `__typetests__`, whose tests need the hooks
 * unregistered. An app writes the same augmentation against
 * '@mongrov/data-access'.
 */
import { z } from 'zod'
import { defineMutation, defineQuery } from '../define'
import { useAppMutation, useAppQuery } from '../hooks'

const _registry = {
  queries: {
    'spo2.day': defineQuery({
      engine: 'duckdb',
      input: z.object({ userId: z.string(), offset: z.number() }),
      output: z.object({ dayAvg: z.number().nullable() }),
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
  events: {},
}

declare module '../types' {
  interface Register {
    registry: typeof _registry
  }
}

export function useInferred(): void {
  // Output derived from the entry the name selects — no annotation.
  const day = useAppQuery('spo2.day', { userId: 'u', offset: 0 })
  const avg: number | null | undefined = day.data?.dayAvg
  void avg

  // A bare number — the `{ value: number }` guess that once compiled is now
  // a type error.
  const level = useAppQuery('user.safeLevel', { userId: 'u' })
  const n: number | undefined = level.data
  void n
  // @ts-expect-error the output is a number, not `{ value: number }`
  void level.data?.value

  // @ts-expect-error `offset` is required by spo2.day's input schema
  useAppQuery('spo2.day', { userId: 'u' })

  // @ts-expect-error not a registered query name
  useAppQuery('spo2.week', { userId: 'u' })

  const dismiss = useAppMutation('insight.dismiss')
  dismiss.mutate({ insightId: 'i1' })
  // @ts-expect-error `insightId` is required
  dismiss.mutate({})
  // @ts-expect-error not a registered mutation name
  useAppMutation('insight.undismiss')
}

export function useLegacyFormOnceRegistered(): void {
  // Explicit type arguments still compile for a registered name…
  useAppQuery<{ userId: string }, number>('user.safeLevel', { userId: 'u' })
  // @ts-expect-error …but a typo no longer does
  useAppQuery<{ userId: string }, number>('user.safeLevle', { userId: 'u' })
}
