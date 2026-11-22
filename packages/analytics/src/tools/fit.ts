/**
 * The character budget for a structured result.
 *
 * 1. Render once.
 * 2. Over the limit: drop one item from the longest declared list (lists are
 *    newest first, so the last item is the oldest), set `truncated`, render
 *    again; repeat. A floor keeps at least one item in every list.
 * 3. Still over: cut at the last line break that fits, append
 *    `truncated: cut`, and set `hardCut`. Header and guidance lines come
 *    first in every renderer's output, so they survive the cut.
 *
 * The limit is `min(maxChars, turn remaining)`, where turn remaining is the
 * answer's character budget less what earlier calls in it returned, with a
 * floor of `MIN_TURN_CHARS` so a late call is never starved to nothing.
 * `truncated` is the framework's alone: whatever an impl set is overwritten.
 */

import type { ToolOutcome, ToolTruncation } from './outcome'
import type { RenderContext, ToolRenderer } from './render'

export interface ToolBudget {
  /** Max chars of rendered text. Default: `config.outputBudget.maxChars` (default 1200). */
  maxChars?: number
  /** Dotted paths of newest-first arrays in `data` the framework may shorten, e.g. ['items']. */
  listPaths?: readonly string[]
  /** Which end of each list survives; default 'newest' (drop from the end). */
  keep?: 'newest' | 'oldest'
}

export const DEFAULT_MAX_CHARS = 1200
export const DEFAULT_TURN_CHARS = 3600
/** A late call in an answer still gets this much. */
export const MIN_TURN_CHARS = 300

const HARD_CUT_SUFFIX = '\ntruncated: cut'

export interface FitResult {
  readonly text: string
  /** The envelope as rendered (its `truncated` set when anything was dropped). */
  readonly outcome: ToolOutcome<unknown>
}

function getPath(data: unknown, path: string): unknown {
  let cur: unknown = data
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object')
      return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** A copy of `data` with the array at `path` replaced (parents copied, the rest shared). */
function setPath(data: unknown, path: string, value: unknown[]): unknown {
  const [head, ...rest] = path.split('.')
  const obj = (data ?? {}) as Record<string, unknown>
  return { ...obj, [head]: rest.length === 0 ? value : setPath(obj[head], rest.join('.'), value) }
}

/** Cut `text` at the last line break that leaves room for the suffix. */
export function hardCut(text: string, limit: number): string {
  const room = Math.max(0, limit - HARD_CUT_SUFFIX.length)
  const at = text.lastIndexOf('\n', room)
  return `${text.slice(0, at > 0 ? at : room)}${HARD_CUT_SUFFIX}`
}

export function fitOutcome(
  o: ToolOutcome<unknown>,
  render: ToolRenderer<any>,
  ctx: RenderContext,
  budget: ToolBudget | undefined,
): FitResult {
  const limit = ctx.maxChars
  let current: ToolOutcome<unknown> = { ...o, truncated: null }
  let text = render(current, ctx)
  if (text.length <= limit)
    return { text, outcome: current }

  const keep = budget?.keep ?? 'newest'
  const paths = (budget?.listPaths ?? []).filter(p => Array.isArray(getPath(o.data, p)))
  const dropped = new Map<string, number>(paths.map(p => [p, 0]))
  let data = o.data

  while (o.data !== null && paths.length > 0) {
    // The longest list that can still lose an item.
    let longest: string | null = null
    let longestLen = 1
    for (const p of paths) {
      const len = (getPath(data, p) as unknown[]).length
      if (len > longestLen) {
        longest = p
        longestLen = len
      }
    }
    if (longest === null)
      break
    const list = getPath(data, longest) as unknown[]
    data = setPath(data, longest, keep === 'newest' ? list.slice(0, -1) : list.slice(1))
    dropped.set(longest, dropped.get(longest)! + 1)
    const total = [...dropped.values()].reduce((a, b) => a + b, 0)
    const mostPath = [...dropped.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const truncated: ToolTruncation = { path: mostPath, droppedItems: total, kept: keep, hardCut: false }
    current = { ...o, data, truncated }
    text = render(current, ctx)
    if (text.length <= limit)
      return { text, outcome: current }
  }

  const prior = current.truncated
  current = {
    ...current,
    truncated: {
      path: prior?.path ?? '',
      droppedItems: prior?.droppedItems ?? 0,
      kept: keep,
      hardCut: true,
    },
  }
  return { text: hardCut(render(current, ctx), limit), outcome: current }
}
