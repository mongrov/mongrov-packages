/**
 * Rendering a `ToolOutcome` into the ONE string the model reads.
 *
 * Pluggable: the renderer is chosen per call, in this order of precedence —
 *   1. `config.render.byTool[name]`
 *   2. the definition's `render`
 *   3. `config.render.default`
 *   4. `renderers.lines`
 * — so a host can switch every tool's format from one setting (an eval A/B)
 * without touching any tool.
 *
 * `lines` (the default) prints `key: value` lines: no quotes or braces for a
 * small model to track, and roughly 40 % fewer characters than compact JSON
 * on a typical list result. The header lines and the guidance come before
 * the data, so a hard cut at the end of the text can never remove them.
 */

import type { ToolOutcome } from './outcome'

export interface RenderContext {
  readonly toolName: string
  /** The character limit this render is measured against (the budget trims after). */
  readonly maxChars: number
  readonly now: Date
}

export type ToolRenderer<D = unknown> = (o: ToolOutcome<D>, ctx: RenderContext) => string

const NEWLINE_RE = /\s*[\r\n]\s*/g
const WHITESPACE_RE = /\s/

/** One line, whatever the string held. */
function oneLine(s: string): string {
  return s.replace(NEWLINE_RE, ' ')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
}

/** A value inside a line: scalars bare, anything nested as compact JSON. */
function scalar(v: unknown): string {
  if (v === null || v === undefined)
    return 'null'
  if (v instanceof Date)
    return v.toISOString()
  if (typeof v === 'string')
    return oneLine(v)
  if (typeof v === 'number' || typeof v === 'boolean')
    return String(v)
  return JSON.stringify(v)
}

/** A cell in a table row: quoted when it holds whitespace or is empty, so columns stay countable. */
function cell(v: unknown): string {
  const s = scalar(v)
  return s.length === 0 || WHITESPACE_RE.test(s) ? JSON.stringify(s) : s
}

/** `k=v, k=v` for a nested object. */
function pairs(o: Record<string, unknown>): string {
  const keys = Object.keys(o).filter(k => o[k] !== undefined)
  if (keys.length === 0)
    return 'none'
  return keys.map(k => `${k}=${isPlainObject(o[k]) || Array.isArray(o[k]) ? JSON.stringify(o[k]) : scalar(o[k])}`).join(', ')
}

function renderValue(key: string, v: unknown, out: string[]): void {
  if (v === undefined)
    return
  if (Array.isArray(v)) {
    if (v.length === 0) {
      out.push(`${key}: none`)
      return
    }
    if (v.every(isPlainObject)) {
      // A table: the header names the columns once, one line per item.
      const cols: string[] = []
      for (const item of v) {
        for (const k of Object.keys(item)) {
          if (!cols.includes(k) && item[k] !== undefined)
            cols.push(k)
        }
      }
      out.push(`${key} (${cols.join(' ')}):`)
      for (const item of v)
        out.push(`  ${cols.map(c => cell(item[c])).join(' ')}`)
      return
    }
    out.push(`${key}: ${v.map(scalar).join(', ')}`)
    return
  }
  if (isPlainObject(v)) {
    out.push(`${key}: ${pairs(v)}`)
    return
  }
  out.push(`${key}: ${scalar(v)}`)
}

/** "12 min ago", from an ISO instant and the clock. */
export function describeAge(asOf: string, now: Date): string {
  const ms = now.getTime() - Date.parse(asOf)
  if (Number.isNaN(ms))
    return 'unknown'
  const min = Math.floor(ms / 60_000)
  if (min < 1)
    return 'just now'
  if (min < 60)
    return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 48)
    return `${h} h ago`
  return `${Math.floor(h / 24)} days ago`
}

function windowLine(o: ToolOutcome<unknown>): string | null {
  const w = o.window
  if (!w)
    return null
  const span = w.from === w.to ? w.from : `${w.from} to ${w.to}`
  const notes = [w.label, w.partialToday ? 'today partial' : undefined].filter(Boolean)
  return `window: ${span}${notes.length > 0 ? ` (${notes.join(', ')})` : ''} ${w.timezone}`
}

function truncatedLine(o: ToolOutcome<unknown>): string | null {
  const t = o.truncated
  if (!t || t.droppedItems === 0)
    return null
  const which = t.kept === 'newest' ? 'older' : 'newer'
  return `truncated: ${t.droppedItems} ${which} ${t.droppedItems === 1 ? 'item' : 'items'} left out`
}

/** `key: value` lines: header, guidance, data in the schema's key order, then the truncation note. */
const lines: ToolRenderer = (o, ctx) => {
  const out: string[] = []
  out.push(o.status === 'error' && o.error ? `status: error (${o.error.code})` : `status: ${o.status}`)
  const w = windowLine(o)
  if (w)
    out.push(w)
  if (o.status !== 'error')
    out.push(`as_of: ${o.asOf ? describeAge(o.asOf, ctx.now) : 'unknown'}`)
  if (o.error)
    out.push(`error: ${oneLine(o.error.message)}`)
  for (const g of o.guidance)
    out.push(`note: ${oneLine(g)}`)
  if (o.data !== null && o.data !== undefined) {
    if (isPlainObject(o.data)) {
      for (const k of Object.keys(o.data))
        renderValue(k, o.data[k], out)
    }
    else {
      renderValue('data', o.data, out)
    }
  }
  const t = truncatedLine(o)
  if (t)
    out.push(t)
  return out.join('\n')
}

/** Compact, single-line JSON of the whole envelope. */
const json: ToolRenderer = o => JSON.stringify(o)

/**
 * Pack-written prose for an `ok` result; any other status falls back to
 * `lines`, so refusals and empties read the same in every format.
 */
function sentence(template: (o: ToolOutcome<any>) => string): ToolRenderer {
  return (o, ctx) => {
    if (o.status !== 'ok')
      return lines(o, ctx)
    const t = truncatedLine(o)
    const text = oneLine(template(o))
    return t ? `${text}\n${t}` : text
  }
}

export const renderers = Object.freeze({
  /** The default. */
  lines,
  json,
  sentence,
})

/** How the host picks renderers (`AnalyticsToolsConfig.render`). */
export interface ToolRenderConfig {
  /** Every tool's renderer unless the tool or `byTool` names one. */
  default?: ToolRenderer
  /** Per tool name; wins over everything. */
  byTool?: Readonly<Record<string, ToolRenderer>>
}

/** @internal The renderer for one call, by the precedence above. */
export function pickRenderer(
  toolName: string,
  own: ToolRenderer<any> | undefined,
  config: ToolRenderConfig | undefined,
): ToolRenderer<any> {
  return config?.byTool?.[toolName] ?? own ?? config?.default ?? renderers.lines
}
