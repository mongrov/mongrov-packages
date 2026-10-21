import type { RelationFor } from '../core/bounded-read'
import type { ToolImpl } from './types'
import { executeBoundedRead } from '../core/bounded-read'
import { describeError } from '../core/errors'

type ToolCtx = Parameters<ToolImpl<never>>[1]

/**
 * A tool's read through the bounded quality macros, with the view form as
 * the fallback (mongrov-packages#44, `executeBounded`). `build` names each
 * relation through `relation(view, window)`; `params` gets the view-form SQL,
 * which binds the same parameters as the bounded one.
 *
 * A failed bounded statement is logged as `tools.bounded_failed` and the call
 * is answered from the views — the model never sees the difference.
 */
export function toolRead<T>(
  ctx: ToolCtx,
  tool: string,
  build: (relation: RelationFor) => string,
  params: (sql: string) => Record<string, unknown>,
): Promise<T[]> {
  return executeBoundedRead<T>(ctx.analytics, build, params, cause =>
    ctx.logger?.warn('tools.bounded_failed', { tool, error: describeError(cause) }))
}
