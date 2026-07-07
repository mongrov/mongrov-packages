/**
 * Registry primitives — defineQuery / defineMutation / defineEvent.
 *
 * The Define API is entirely local: no engine access, no React, no
 * dispatcher. It hands back typed, discriminated handles that the
 * dispatcher (arriving in a later task) can safely inspect and route.
 *
 * See data-access/spec.md §Define API.
 */

import { DataAccessError } from './errors'
import type {
  EventDefinition,
  MutationConfig,
  MutationDefinition,
  QueryConfig,
  QueryDefinition,
} from './types'

/**
 * Register a typed query. Runtime enforces the engine-specific required
 * field so JS callers get a loud error even when TypeScript is skipped.
 */
export function defineQuery<TInput, TOutput>(
  config: QueryConfig<TInput, TOutput>
): QueryDefinition<TInput, TOutput> {
  assertQueryEngineField(config)
  return { __kind: 'query', config }
}

/**
 * Register a typed mutation. `exec` is required; `invalidates` patterns
 * fire through the invalidation bus on success.
 */
export function defineMutation<TInput, TOutput>(
  config: MutationConfig<TInput, TOutput>
): MutationDefinition<TInput, TOutput> {
  if (typeof config.exec !== 'function') {
    throw new DataAccessError(
      'define_config_invalid',
      'defineMutation requires an `exec` function'
    )
  }
  return { __kind: 'mutation', config }
}

/**
 * Register a typed event. Payload type is inferred at the point of use
 * (via useAppEvent). No runtime state is captured here.
 */
export function defineEvent<TPayload>(): EventDefinition<TPayload> {
  return { __kind: 'event' }
}

function assertQueryEngineField<TInput, TOutput>(
  config: QueryConfig<TInput, TOutput>
): void {
  switch (config.engine) {
    case 'duckdb':
      if (typeof config.sql !== 'string' || config.sql.length === 0) {
        throw new DataAccessError(
          'define_config_invalid',
          "defineQuery: engine 'duckdb' requires a non-empty `sql` string"
        )
      }
      return
    case 'rxdb':
      if (typeof config.query !== 'function') {
        throw new DataAccessError(
          'define_config_invalid',
          "defineQuery: engine 'rxdb' requires a `query` function"
        )
      }
      return
    case 'kv':
      if (typeof config.keyBuilder !== 'function') {
        throw new DataAccessError(
          'define_config_invalid',
          "defineQuery: engine 'kv' requires a `keyBuilder` function"
        )
      }
      return
    default: {
      // Exhaustiveness: if a new engine is added, TS surfaces this at compile time.
      const exhaustive: never = config
      throw new DataAccessError(
        'define_config_invalid',
        `defineQuery: unknown engine ${JSON.stringify(exhaustive)}`
      )
    }
  }
}
