/**
 * Answers ("turns"): the calls a model makes while composing one answer.
 *
 * The host opens one per answer (`handle.beginTurn()`, closed in a
 * `finally`). Inside it the framework:
 *   - caps the calls (`callLimit.perTurn`, default 4): a later call is
 *     refused `call_limit`, audited, and reaches `onResult`;
 *   - answers the first repeat of the same tool with the same arguments
 *     from the turn's cache (`dedupe`, default on): audited `cached`, not
 *     counted; the second and later repeats are refused `call_limit` with
 *     `DUPLICATE_CALL_GUIDANCE` only (audited `cached`, counted);
 *   - shares one character budget across the answer's results (`turnChars`).
 * Outside a turn (MCP, tests) there is no cap and no cache, only the rate
 * limit.
 */

import type { ToolOutcome } from './outcome'
import type { AuditOutcome } from './types'

export interface CachedCall {
  readonly text: string
  readonly outcome: ToolOutcome<unknown>
  readonly auditOutcome: AuditOutcome
  readonly legacy: boolean
  readonly resultBytes: number | null
  readonly resultRowCount: number | null
  readonly truncatedItems: number | null
}

/** @internal A turn's running state. */
export interface TurnState {
  readonly id: string
  /** Every call made in the turn, cached and refused ones included (the next call's index). */
  calls: number
  /** Calls counted against the cap (a served repeat is not; a refused one is). */
  counted: number
  refused: number
  /** Characters returned to the model so far. */
  chars: number
  readonly cache: Map<string, CachedCall>
  /** Repeats of each cached call so far (the first is served, later ones refused). */
  readonly repeats: Map<string, number>
  open: boolean
}

export interface TurnSummary {
  /** Calls made, cached repeats included. */
  readonly calls: number
  /** Calls refused (`call_limit` incl. refused repeats, invalid arguments, rate limit, authorization, no context). */
  readonly refused: number
  /** Characters returned to the model. */
  readonly chars: number
}

export interface ToolTurn {
  readonly id: string
  /** Close the turn (idempotent) and report what it used. */
  end: () => TurnSummary
}

export interface CallLimitPolicy {
  readonly perTurn: number | null
  readonly dedupe: boolean
}

let turnSeq = 0

/** @internal The handle's one current turn. Answers are serialized by the host's chat. */
export function createTurnTracker() {
  let current: TurnState | null = null
  return {
    current: (): TurnState | null => (current?.open ? current : null),
    begin(opts?: { id?: string }): ToolTurn {
      if (current)
        current.open = false
      turnSeq += 1
      const state: TurnState = {
        id: opts?.id ?? `turn-${Date.now().toString(36)}-${turnSeq}`,
        calls: 0,
        counted: 0,
        refused: 0,
        chars: 0,
        cache: new Map(),
        repeats: new Map(),
        open: true,
      }
      current = state
      return {
        id: state.id,
        end() {
          state.open = false
          if (current === state)
            current = null
          return { calls: state.calls, refused: state.refused, chars: state.chars }
        },
      }
    },
  }
}

export type TurnTracker = ReturnType<typeof createTurnTracker>

/** Key of a call for the turn cache: the tool and its validated arguments, keys sorted. */
export function callKey(toolName: string, args: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v))
      return v.map(canon)
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const o = v as Record<string, unknown>
      return Object.fromEntries(Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => [k, canon(o[k])]))
    }
    return v
  }
  return `${toolName}\u0000${JSON.stringify(canon(args))}`
}
