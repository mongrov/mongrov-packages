/**
 * `defineTool` — declare a structured tool: input and output Zod schemas, an
 * impl that returns a `ToolOutcome`, and optionally a renderer and a budget.
 *
 * It is an identity function (for type inference) plus a lint at definition
 * time: in dev and test builds a name, description or input schema the
 * on-device subset cannot carry throws, so a bad definition cannot ship.
 *
 * A `ToolDefinition` is a valid `PackTool`: it goes in `pack.tools`, or to
 * `handle.add` for a host's own tool.
 */

import type { z, ZodTypeAny } from 'zod'
import type { ToolBudget } from './fit'
import type { ToolOutcome } from './outcome'
import type { ToolRenderer } from './render'
import type { LintIssue } from './schema-lint'
import type { ToolImpl, ToolResult } from './types'
import { AnalyticsError } from '../core/errors'
import { toJsonSchemaObject } from './json-schema'
import { isTestRuntime } from './runtime'
import { lintToolInputSchema } from './schema-lint'

/** MCP tool annotations. The framework's default is read-only, idempotent and closed-world. */
export interface ToolAnnotations {
  readOnlyHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
  destructiveHint?: boolean
}

/** `ToolImpl`'s context plus the answer (turn) the call belongs to. */
export type ToolExecContext = Parameters<ToolImpl<never>>[1] & {
  /** The answer this call is part of (`handle.beginTurn`); null outside one (MCP, tests). */
  readonly turn: { readonly id: string, readonly callIndex: number } | null
  readonly now: () => Date
}

export interface ToolDefinition<I extends ZodTypeAny = ZodTypeAny, O extends ZodTypeAny = ZodTypeAny> {
  /** `/^[a-z][A-Za-z0-9]{2,39}$/` */
  name: string
  /** MCP `title`. */
  title?: string
  /** Purpose and when to use it; no argument list (the schema carries that). At most 200 chars. */
  description: string
  /** A flat object that passes `lintToolInputSchema`. */
  inputSchema: I
  /** Schema of `ToolOutcome.data`. Optional only for the `ToolResult` compatibility path. */
  outputSchema?: O
  render?: ToolRenderer<z.output<O>>
  budget?: ToolBudget
  annotations?: ToolAnnotations
  impl: (input: z.output<I>, ctx: ToolExecContext) => Promise<ToolOutcome<z.input<O>> | ToolResult>
}

export const TOOL_NAME_RE = /^[a-z][A-Za-z0-9]{2,39}$/
export const MAX_TOOL_DESCRIPTION_CHARS = 200

declare const __DEV__: boolean | undefined

function lintAtDefinition(): boolean {
  return (typeof __DEV__ !== 'undefined' && __DEV__ === true) || isTestRuntime()
}

/** Every issue with a definition: its name, description, output schema and input schema. */
export function lintToolDefinition(def: Pick<ToolDefinition, 'name' | 'description' | 'inputSchema' | 'outputSchema'>): LintIssue[] {
  const issues: LintIssue[] = []
  if (!TOOL_NAME_RE.test(def.name))
    issues.push({ level: 'error', path: '', rule: 'name', message: `tool name "${def.name}" must match ${TOOL_NAME_RE}` })
  if (def.description.length > MAX_TOOL_DESCRIPTION_CHARS)
    issues.push({ level: 'warning', path: '', rule: 'description', message: `description is ${def.description.length} chars (keep to ${MAX_TOOL_DESCRIPTION_CHARS})` })
  if (!def.outputSchema)
    issues.push({ level: 'warning', path: '', rule: 'output-schema', message: 'no outputSchema: the tool runs on the ToolResult compatibility path' })
  issues.push(...lintToolInputSchema(toJsonSchemaObject(def.inputSchema)))
  return issues
}

export function defineTool<I extends ZodTypeAny, O extends ZodTypeAny>(def: ToolDefinition<I, O>): ToolDefinition<I, O> {
  if (lintAtDefinition()) {
    const errors = lintToolDefinition(def).filter(i => i.level === 'error')
    if (errors.length > 0) {
      throw new AnalyticsError(
        'invalid_config',
        `tool "${def.name}": ${errors.map(e => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ')}`,
      )
    }
  }
  return def
}
