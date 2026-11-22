/**
 * `ToolOutcome<D>` — the envelope every structured tool returns.
 *
 * A structured tool's impl returns one of these instead of prose. The
 * framework validates it (the invariants below, then `data` against the
 * tool's `outputSchema`), runs every pack's copy guard over each string in
 * it, renders ONE string for the model, trims it to the budget, audits it and
 * hands the structured value to the host through `onResult`.
 *
 * Everything here is generic: a window of local days, a status, items in
 * lists, guidance for the model. No domain concept.
 */

/** How a call ended, as the model and the host see it. */
export type ToolStatus = 'ok' | 'empty' | 'insufficient' | 'error'

export const TOOL_STATUSES: readonly ToolStatus[] = Object.freeze(['ok', 'empty', 'insufficient', 'error'])

/**
 * Generic error codes. The framework sets every one of them; an impl may
 * return only `invalid_args`, through `outcome.invalid` (an impl that cannot
 * answer for any other reason throws, and the framework records `internal`).
 */
export type ToolErrorCode
  = | 'invalid_args' // a schema refusal, or the impl's own argument check
    | 'not_authorized'
    | 'rate_limited'
    | 'call_limit' // the per-answer call cap was reached
    | 'no_context'
    | 'output_invalid' // the envelope or its data failed validation
    | 'copy_guard' // a returned string broke a pack's copy rules
    | 'internal' // the impl (or a renderer) threw

export const TOOL_ERROR_CODES: readonly ToolErrorCode[] = Object.freeze([
  'invalid_args',
  'not_authorized',
  'rate_limited',
  'call_limit',
  'no_context',
  'output_invalid',
  'copy_guard',
  'internal',
])

export interface ToolWindow {
  /** First local calendar day covered, YYYY-MM-DD, inclusive. */
  readonly from: string
  /** Last local calendar day covered, YYYY-MM-DD, inclusive. */
  readonly to: string
  /** IANA zone the days are in. */
  readonly timezone: string
  /** `to` is today and today is still in progress. */
  readonly partialToday: boolean
  /** The pack's name for the period, repeated to the model (e.g. "this_week"). At most 24 chars. */
  readonly label?: string
}

export interface ToolError {
  readonly code: ToolErrorCode
  /** One sentence the model may act on. */
  readonly message: string
  /** Whether a corrected or later call can succeed. */
  readonly retryable: boolean
  readonly fieldErrors?: Readonly<Record<string, string>>
}

export interface ToolTruncation {
  /** Dotted path of the list that lost the most items (e.g. "items"). */
  readonly path: string
  /** Items dropped across every declared list. */
  readonly droppedItems: number
  /** Which end survived. Lists are declared newest first, so the default is 'newest'. */
  readonly kept: 'newest' | 'oldest'
  /** The rendered text was also cut at a line boundary (last resort). */
  readonly hardCut: boolean
}

/** The envelope every structured tool returns. */
export interface ToolOutcome<D = unknown> {
  readonly status: ToolStatus
  /** Validated against the tool's `outputSchema` whenever non-null. */
  readonly data: D | null
  readonly window: ToolWindow | null
  /** ISO-8601 UTC instant of the newest underlying record; null when unknown or there is none. */
  readonly asOf: string | null
  readonly error: ToolError | null
  /** Set by the framework only; an impl's value is overwritten. */
  readonly truncated: ToolTruncation | null
  /** Instructions to the MODEL, kept apart from data. At most 3 items of at most 140 chars. */
  readonly guidance: readonly string[]
}

/** The envelope fields an impl supplies next to `data`. */
export interface OutcomeMeta {
  window: ToolWindow | null
  asOf: string | null
  guidance?: readonly string[]
}

export const MAX_GUIDANCE_ITEMS = 3
export const MAX_GUIDANCE_CHARS = 140
export const MAX_WINDOW_LABEL_CHARS = 24

/** Whether a call that failed this way can succeed when repeated or corrected. */
const RETRYABLE: Readonly<Record<ToolErrorCode, boolean>> = Object.freeze({
  invalid_args: true,
  not_authorized: false,
  rate_limited: true,
  call_limit: false,
  no_context: false,
  output_invalid: false,
  copy_guard: false,
  internal: false,
})

function envelope<D>(
  status: Exclude<ToolStatus, 'error'>,
  data: D | null,
  meta: OutcomeMeta,
): ToolOutcome<D> {
  return {
    status,
    data,
    window: meta.window,
    asOf: meta.asOf,
    error: null,
    truncated: null,
    guidance: [...(meta.guidance ?? [])],
  }
}

/**
 * Pure constructors, so an impl never hand-builds an envelope.
 *
 * - `ok`: measured, enough to answer.
 * - `empty`: nothing in the window (`data` optional, e.g. only a "last
 *   record at" field).
 * - `insufficient`: something there, not enough to judge (nulls where below
 *   a floor, plus progress such as days collected).
 * - `invalid`: the impl's own argument refusal ("that day is out of reach").
 */
export const outcome = Object.freeze({
  ok<D>(data: D, meta: OutcomeMeta): ToolOutcome<D> {
    return envelope('ok', data, meta)
  },
  empty<D>(meta: OutcomeMeta, data?: D): ToolOutcome<D> {
    return envelope('empty', data ?? null, meta)
  },
  insufficient<D>(data: D, meta: OutcomeMeta): ToolOutcome<D> {
    return envelope('insufficient', data, meta)
  },
  /** The only error an impl may return; anything else it throws, and the framework records `internal`. */
  invalid(message: string, fieldErrors?: Record<string, string>): ToolOutcome<never> {
    return {
      status: 'error',
      data: null,
      window: null,
      asOf: null,
      error: { code: 'invalid_args', message, retryable: true, ...(fieldErrors ? { fieldErrors } : {}) },
      truncated: null,
      guidance: [],
    }
  },
})

/** @internal An error envelope the framework builds. */
export function errorOutcome(
  code: ToolErrorCode,
  message: string,
  guidance: readonly string[] = [],
  fieldErrors?: Record<string, string>,
): ToolOutcome<never> {
  return {
    status: 'error',
    data: null,
    window: null,
    asOf: null,
    error: { code, message, retryable: RETRYABLE[code], ...(fieldErrors ? { fieldErrors } : {}) },
    truncated: null,
    guidance: [...guidance],
  }
}

/** Whether `value` is an envelope rather than a legacy `ToolResult` (`{ text, rowCount, bytes }`). */
export function isToolOutcome(value: unknown): value is ToolOutcome<unknown> {
  if (value === null || typeof value !== 'object')
    return false
  const v = value as Record<string, unknown>
  return typeof v.status === 'string' && 'data' in v && !('text' in v && 'rowCount' in v)
}

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/

function validLocalDate(s: unknown): s is string {
  if (typeof s !== 'string' || !LOCAL_DATE_RE.test(s))
    return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/**
 * @internal The envelope invariants. Returns the broken rules as
 * `path: problem` lines (paths and rules only, never values, so the audit
 * may store them), or an empty list.
 *
 * | status       | data     | error    |
 * | ok           | required | null     |
 * | empty        | optional | null     |
 * | insufficient | required | null     |
 * | error        | null     | required |
 */
export function checkEnvelope(o: ToolOutcome<unknown>, opts: { impl: boolean }): string[] {
  const problems: string[] = []
  if (!TOOL_STATUSES.includes(o.status))
    problems.push('status: not one of ok, empty, insufficient, error')
  const hasData = o.data !== null && o.data !== undefined
  const hasError = o.error !== null && o.error !== undefined
  if ((o.status === 'ok' || o.status === 'insufficient') && !hasData)
    problems.push(`data: required when status is ${o.status}`)
  if (o.status !== 'error' && hasError)
    problems.push(`error: must be null when status is ${o.status}`)
  if (o.status === 'error') {
    if (hasData)
      problems.push('data: must be null when status is error')
    if (!hasError) {
      problems.push('error: required when status is error')
    }
    else {
      const e = o.error!
      if (!TOOL_ERROR_CODES.includes(e.code))
        problems.push('error.code: not a known code')
      else if (opts.impl && e.code !== 'invalid_args')
        problems.push('error.code: an impl may return invalid_args only (use outcome.invalid; throw for anything else)')
      if (typeof e.message !== 'string' || e.message.length === 0)
        problems.push('error.message: required')
    }
  }
  if (o.window !== null && o.window !== undefined) {
    const w = o.window
    if (!validLocalDate(w.from))
      problems.push('window.from: not a YYYY-MM-DD date')
    if (!validLocalDate(w.to))
      problems.push('window.to: not a YYYY-MM-DD date')
    if (validLocalDate(w.from) && validLocalDate(w.to) && w.from > w.to)
      problems.push('window: from is after to')
    if (typeof w.timezone !== 'string' || w.timezone.length === 0)
      problems.push('window.timezone: required')
    if (typeof w.partialToday !== 'boolean')
      problems.push('window.partialToday: not a boolean')
    if (w.label !== undefined && (typeof w.label !== 'string' || w.label.length > MAX_WINDOW_LABEL_CHARS))
      problems.push(`window.label: longer than ${MAX_WINDOW_LABEL_CHARS} chars`)
  }
  else if (o.window === undefined) {
    problems.push('window: required (null when there is none)')
  }
  if (o.asOf === undefined)
    problems.push('asOf: required (null when unknown)')
  else if (o.asOf !== null && (typeof o.asOf !== 'string' || !ISO_INSTANT_RE.test(o.asOf) || Number.isNaN(Date.parse(o.asOf))))
    problems.push('asOf: not an ISO-8601 instant')
  if (!Array.isArray(o.guidance)) {
    problems.push('guidance: not a list')
  }
  else {
    if (o.guidance.length > MAX_GUIDANCE_ITEMS)
      problems.push(`guidance: more than ${MAX_GUIDANCE_ITEMS} items`)
    o.guidance.forEach((g, i) => {
      if (typeof g !== 'string')
        problems.push(`guidance.${i}: not a string`)
      else if (g.length > MAX_GUIDANCE_CHARS)
        problems.push(`guidance.${i}: longer than ${MAX_GUIDANCE_CHARS} chars`)
    })
  }
  return problems
}

/** @internal Every string an envelope carries (data leaves, guidance, the error message, the window label). */
export function stringLeaves(o: ToolOutcome<unknown>): string[] {
  const out: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      out.push(v)
    }
    else if (Array.isArray(v)) {
      v.forEach(walk)
    }
    else if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      for (const k of Object.keys(v))
        walk((v as Record<string, unknown>)[k])
    }
  }
  walk(o.data)
  o.guidance.forEach(walk)
  if (o.error)
    walk(o.error.message)
  if (o.window?.label)
    walk(o.window.label)
  return out
}

/**
 * @internal A deep, frozen copy of a JSON-like value, so a listener cannot
 * change what was audited. Plain objects, arrays, primitives and `Date` only
 * (what a validated envelope holds); `structuredClone` is not on every JS
 * engine the host runs.
 */
export function frozenCopy<T>(value: T): T {
  const copy = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object')
      return v
    if (v instanceof Date)
      return Object.freeze(new Date(v.getTime()))
    if (Array.isArray(v))
      return Object.freeze(v.map(copy))
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v))
      out[k] = copy((v as Record<string, unknown>)[k])
    return Object.freeze(out)
  }
  return copy(value) as T
}
