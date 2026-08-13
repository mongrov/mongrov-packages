/**
 * Invalidation event bus.
 *
 * Backed by `mitt` for exact-match subscribe/emit. Pattern subscriptions
 * are held in a separate map and matched with the frozen glob semantics:
 *
 *   - `*`  matches exactly one `:`-delimited segment
 *   - `**` matches one or more segments
 *
 * All handlers run inside a try/catch so a throw in one subscriber does
 * not prevent later subscribers from running (T-10).
 *
 * See data-access/spec.md §Invalidation event bus for the matching table.
 */

import type { Emitter } from 'mitt'

import type { EventBus, Unsubscribe } from './types'
import mitt from 'mitt'
import { DataAccessError } from './errors'

type ExactHandler = (payload: unknown) => void
type PatternHandler = (name: string, payload: unknown) => void

interface PatternEntry {
  handler: PatternHandler
  regex: RegExp
}

type MittEvents = Record<string, unknown>

export function createEventBus(): EventBus {
  const exact: Emitter<MittEvents> = mitt<MittEvents>()
  const patterns = new Set<PatternEntry>()

  return {
    emit<T>(name: string, payload: T): void {
      // Exact subscribers first (mitt handles its own isolation loop, but
      // we still wrap mitt.emit so a throw inside doesn't skip patterns).
      try {
        exact.emit(name, payload as unknown)
      }
      catch (err) {
        reportHandlerError(err, name)
      }
      for (const entry of patterns) {
        if (entry.regex.test(name)) {
          try {
            entry.handler(name, payload as unknown)
          }
          catch (err) {
            reportHandlerError(err, name)
          }
        }
      }
    },

    subscribe<T>(
      name: string,
      handler: (payload: T) => void,
    ): Unsubscribe {
      if (typeof name !== 'string' || name.length === 0) {
        throw new DataAccessError(
          'invalid_pattern',
          'subscribe: event name must be a non-empty string',
        )
      }
      const wrapped: ExactHandler = (payload) => {
        try {
          handler(payload as T)
        }
        catch (err) {
          reportHandlerError(err, name)
        }
      }
      exact.on(name, wrapped)
      return () => exact.off(name, wrapped)
    },

    subscribePattern<T>(
      pattern: string,
      handler: (name: string, payload: T) => void,
    ): Unsubscribe {
      const regex = compileGlob(pattern)
      const entry: PatternEntry = {
        handler: handler as PatternHandler,
        regex,
      }
      patterns.add(entry)
      return () => {
        patterns.delete(entry)
      }
    },
  }
}

/**
 * Compile a frozen-glob pattern into an anchored RegExp.
 *
 * Rules (spec.md §Invalidation event bus):
 *   - `*`  → `[^:]+`       (exactly one non-empty segment)
 *   - `**` → `.+`          (one or more segments)
 *   - other tokens are matched literally (regex-escaped)
 *   - segments are separated by `:` — literal `:` in the output regex
 *
 * Empty patterns and empty segments are rejected. Case-sensitive.
 */
export function compileGlob(pattern: string): RegExp {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new DataAccessError(
      'invalid_pattern',
      'subscribePattern: pattern must be a non-empty string',
    )
  }
  const segments = pattern.split(':')
  const parts = segments.map((seg) => {
    if (seg.length === 0) {
      throw new DataAccessError(
        'invalid_pattern',
        `subscribePattern: empty segment in pattern ${JSON.stringify(pattern)}`,
      )
    }
    if (seg === '**')
      return '.+'
    if (seg === '*')
      return '[^:]+'
    return escapeRegex(seg)
  })
  return new RegExp(`^${parts.join(':')}$`)
}

const REGEX_METACHARS_RE = /[.*+?^${}()|[\]\\]/g

function escapeRegex(literal: string): string {
  return literal.replace(REGEX_METACHARS_RE, '\\$&')
}

function reportHandlerError(err: unknown, name: string): void {
  // Use console.error so the failure is surfaced but does not propagate.
  // A structured DeviceLogger-style injection is a v0.2.0 concern.

  console.error(`[@mongrov/data-access] handler for "${name}" threw:`, err)
}
