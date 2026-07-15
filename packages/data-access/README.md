# @mongrov/data-access

Named-query / mutation / event registry with engine dispatch for `@mongrov` apps.

Screens never import storage engines. Instead, they read via `useAppQuery(name, input)` and write via `useAppMutation(name)` against a single **registry** the app assembles at startup. The provider dispatches to the right engine (DuckDB, RxDB, or KV) and Zod-parses the result before it reaches the UI.

## Features

- **Define API** — `defineQuery`, `defineMutation`, `defineEvent` produce typed handles with a `__kind` discriminator and engine-specific config (SQL for DuckDB, observable factory for RxDB, key builder for KV).
- **Engine dispatch** — `duckdb` (analytics), `rxdb` (reactive stream), `kv` (single-key read). Apps wire concrete adapters into `DataAccessProvider`.
- **Authorize gate** — optional `authorize(input, ctx)` runs before every query and mutation; `false` throws `AuthorizationError`.
- **Tenant auto-binding** — `{ brand, familyId }` from the active `RequestContext` are merged into DuckDB params automatically. Screens never pass tenant.
- **Invalidation event bus** — `mitt`-backed exact-match dispatch plus a glob wrapper (`hrv:*`, `sleep:**`); mutations declare `invalidates`, queries declare `invalidatedBy`, refetches happen automatically.
- **Optimistic mutations** — `optimistic(input, ctx)` surfaces immediately as `data`; reverts on failure.
- **Cache defaults** — 30s `staleTime`, 5min `gcTime`, overridable per query.
- **ESLint plugin** — `no-storage-engine-imports` bans direct `@mongrov/db`, `@mongrov/analytics`, `@mongrov/collab` imports outside the registry directory.

## Install

```bash
pnpm add @mongrov/data-access
# Peer deps
pnpm add @tanstack/react-query zod
# Optional peers (only what you use)
pnpm add @mongrov/db @mongrov/analytics react react-native eslint
```

## Registry pattern

Assemble a registry once — typically under `src/data/` in your app.

```ts
// src/data/queries.ts
import { defineQuery } from '@mongrov/data-access';
import { z } from 'zod';

export const hrvLast7Days = defineQuery({
  engine: 'duckdb',
  input: z.object({ userId: z.string() }),
  output: z.array(z.object({ day: z.string(), rmssd: z.number() })),
  sql: 'SELECT day, rmssd FROM hrv WHERE user_id = $userId AND brand = $brand AND family_id = $familyId ORDER BY day DESC LIMIT 7',
  invalidatedBy: ['hrv:*'],
  staleTime: 60_000,
});
```

```ts
// src/data/mutations.ts
import { defineMutation } from '@mongrov/data-access';
import { z } from 'zod';

export const recordHrvSample = defineMutation({
  input: z.object({ rmssd: z.number(), ts: z.string() }),
  output: z.object({ id: z.string() }),
  exec: async (input, ctx) => {
    // Direct engine access is legal here because this file lives in
    // src/data/, which the ESLint rule's `allowedDirs` grants an
    // exception to.
    return await analytics.insert('hrv', { ...input, userId: ctx.requesterUserId });
  },
  invalidates: ['hrv:sample:added'],
});
```

```ts
// src/data/registry.ts
import { hrvLast7Days } from './queries';
import { recordHrvSample } from './mutations';

export const registry = {
  queries: { 'hrv.last7Days': hrvLast7Days },
  mutations: { 'hrv.record': recordHrvSample },
  events: {},
} as const;
```

Mount the provider at the app root:

```tsx
// src/app/_layout.tsx
import { DataAccessProvider } from '@mongrov/data-access';
import { registry } from '@/data/registry';
import { analyticsEngine } from '@/data/engines';

export default function RootLayout() {
  return (
    <DataAccessProvider
      registry={registry}
      engines={{ duckdb: analyticsEngine }}
      context={() => ({
        requesterUserId: session.userId,
        brand: 'zivaone',
        familyId: session.familyId,
        now: () => new Date(),
      })}
    >
      <Slot />
    </DataAccessProvider>
  );
}
```

Screens consume via hooks — no engine imports:

```tsx
// src/features/hrv/screen.tsx
import { useAppQuery, useAppMutation } from '@mongrov/data-access';

export function HrvScreen() {
  const { data, loading, error } = useAppQuery<
    { userId: string },
    Array<{ day: string; rmssd: number }>
  >('hrv.last7Days', { userId: 'me' });

  const record = useAppMutation<{ rmssd: number; ts: string }, { id: string }>('hrv.record');

  if (loading) return <ActivityIndicator />;
  if (error) return <Text>{error.message}</Text>;

  return (
    <>
      <List data={data} />
      <Button
        title="Record sample"
        onPress={() => record.mutate({ rmssd: 42, ts: new Date().toISOString() })}
      />
    </>
  );
}
```

## API

### `defineQuery(config)`

Returns a `QueryDefinition<Input, Output>` handle with `__kind: 'query'`. Config union by `engine`:

| Field           | duckdb        | rxdb                                | kv                          |
| --------------- | ------------- | ----------------------------------- | --------------------------- |
| Required        | `sql: string` | `query: (db, input) => Observable`  | `keyBuilder: (input) => string` |
| Common          | `output: ZodType` (required), `input?: ZodType`, `invalidatedBy?: string[]`, `authorize?`, `staleTime?`, `gcTime?` |||

- **duckdb** — params include Zod-parsed input **plus** `brand` and `familyId` from `RequestContext`, injected as `$brand` / `$familyId` for `analytics.execute(sql, params)`.
- **rxdb** — returned observable is subscribed in `useAppQuery`. Each emission is Zod-parsed. Unsubscribes on unmount.
- **kv** — `keyBuilder(input)` produces the storage key; the engine's `get(key)` returns the value. No automatic invalidation.

### `defineMutation(config)`

Returns a `MutationDefinition<Input, Output>` handle with `__kind: 'mutation'`.

- `exec(input, ctx) => Promise<Output>` — required.
- `invalidates?: string[]` — event bus patterns fired on success.
- `authorize?(input, ctx) => boolean | Promise<boolean>` — false throws `AuthorizationError`.
- `optimistic?(input, ctx) => Output` — surfaces as `data` while pending; reverts on failure.
- `input?` / `output?` — Zod schemas; validation is applied on both sides.

### `defineEvent<TPayload>()`

Returns an `EventDefinition<TPayload>` handle with `__kind: 'event'`. Payload type flows through `useAppEvent`.

### `useAppQuery<Input, Output>(name, input?)`

Returns `{ data, loading, error, refetch, isStale }`.

- For **duckdb** / **kv**, backed by TanStack `useQuery`. Subscribes to every `invalidatedBy` pattern on mount and invalidates its own cache when a match fires.
- For **rxdb**, subscribes to the observable via `useEffect`. `refetch()` is a no-op — the stream drives updates. Zod-parses on every emission; parse failure surfaces as `error`.
- Cache defaults: `staleTime = 30_000`, `gcTime = 300_000`, both overridable in the query definition.

### `useAppMutation<Input, Output>(name)`

Returns `{ mutate, mutateAsync, loading, error, data, reset }`. On success, emits every entry in `invalidates` on the bus. On failure, clears optimistic state so subsequent renders see `data === undefined`.

### `useAppEvent<TPayload>(name, handler)`

Subscribes to exact-match `name`. Handler ref stays fresh across renders. Unsubscribes on unmount. For glob semantics, call `bus.subscribePattern` directly via `useDataAccessRuntime`.

### `useRequestContext(): RequestContext`

Reads the provider's `context()` callback on every render, so session updates propagate without remount.

### `DataAccessProvider`

```ts
interface DataAccessProviderConfig {
  registry: Registry;
  engines: { duckdb?: DuckdbEngine; rxdb?: RxdbEngine; kv?: KvEngine };
  context: () => RequestContext;
  bus?: EventBus;             // optional; one is minted per provider
  queryClient?: QueryClient;  // optional; one is minted per provider
}
```

Nesting providers is not supported in v0.1 — mount exactly one at the app root.

### `createEventBus(): EventBus`

Standalone factory for tests or non-React callers. Exposes `emit`, `subscribe`, `subscribePattern`. Pattern semantics:

- `hrv:*` — matches one `:`-delimited segment.
- `hrv:**` — matches one or more segments.
- Empty pattern rejected. Case-sensitive.

### Errors

- `DataAccessError` — base class with `.code`. Codes: `engine_missing`, `zod_parse_failed`, `authorization_denied`, `not_implemented`.
- `AuthorizationError` extends `DataAccessError` (`code: 'authorization_denied'`).
- `NotImplementedError` extends `DataAccessError` (`code: 'not_implemented'`); reserved for stubs.

## Registry variance workaround

The exported `Registry` type keys onto
`QueryDefinition<unknown, unknown>` / `MutationDefinition<unknown, unknown>`
as its map value type. Concrete queries authored with `defineQuery` have
narrow input types, which are **contravariant** in function positions
(`authorize`, `keyBuilder`, `handler`). TypeScript's strict mode rejects
a direct assignment even though the runtime dispatcher only reads the
shape.

The standard resolution is a **variance-erased map** — author your
registry as a narrow `as const satisfies` map, then bridge to the loose
`Registry` contract with a single double-cast at the boundary:

```ts
// src/data/registry.ts
import type { Registry } from '@mongrov/data-access';

import { setTenant } from './mutations';
import { heartRateRecent, hrvLast24h } from './queries';

export const registry = {
  queries: {
    'health.heartRateRecent': heartRateRecent,
    'health.hrvLast24h': hrvLast24h,
  },
  mutations: {
    'tenant.set': setTenant,
  },
  events: {},
} as const satisfies { queries: unknown; mutations: unknown; events: unknown };

// Boundary cast — narrow keys stay authored types; only the map value
// widens to the dispatcher's contract.
export const appRegistry = registry as unknown as Registry;
```

Keep this cast confined to the single file that assembles the registry.
Consumers pass `appRegistry` to `DataAccessProvider`; nothing else in the
app touches the loose `Registry` type, so the narrow authored types still
drive `defineQuery`, `useAppQuery`, and codegen downstream.

## ESLint plugin

Blocks direct storage-engine imports outside the registry directory.

```js
// eslint.config.mjs
import dataAccessPlugin from '@mongrov/data-access/eslint';

export default [
  {
    plugins: { '@mongrov/data-access': dataAccessPlugin },
    rules: {
      '@mongrov/data-access/no-storage-engine-imports': ['error', {
        allowedDirs: ['src/data'],
      }],
    },
  },
];
```

- Default block list: `@mongrov/analytics`, `@mongrov/collab`, `@mongrov/db` (subpaths included — `@mongrov/db/kv` is blocked by the same rule).
- `allowedDirs` — path fragments that suppress the rule; the registry directory typically goes here.
- `blockedPackages` — override the default block list.
- Covers `import`, dynamic `import()`, and CommonJS `require()`.

## Testing patterns

The package ships with a full vitest suite you can mirror in-app.

- **In-memory event bus** — `createEventBus()` is standalone and needs no engine wiring.
- **Fake DuckDB engine** — implement `DuckdbEngine.execute(sql, params)` in a couple of lines to drive query tests.
- **Fake RxDB observable** — a `{ subscribe(observer) }` object with `next` / `error` is enough for `useAppQuery('name.rxdb', ...)`.
- **QueryClient with `retry: false`** — avoid retry timeouts in error-surface tests:

  ```ts
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  ```

See `src/__tests__/integration.test.tsx` for a full smoke test wiring registry + provider + hooks together.

## Version

`0.1.0` — first stable cut of the query/mutation/event registry with
engine dispatch. Alpha train (`0.1.0-alpha.0` → `0.1.0-alpha.3`) shipped
under the `alpha` dist-tag while the zod peer-widening and CJS emit for
the ESLint subpath were stabilized. Follow-ups tracked in
[`.specifica/features/data-access/tasks.md`](../../../.specifica/features/data-access/tasks.md):

- Row-level invalidation
- Streaming query results
- Persistent cache (AsyncStorage / MMKV)
- Devtools panel
- Custom engine adapters (GraphQL, REST)

## License

MIT
