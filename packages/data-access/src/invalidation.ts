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

// React Native global; undefined under Node / vitest.
declare const __DEV__: boolean | undefined

type ExactHandler = (payload: unknown) => void
type PatternHandler = (name: string, payload: unknown) => void

interface PatternEntry {
  handler: PatternHandler
  regex: RegExp
}

type MittEvents = Record<string, unknown>

/** Narrow logger shape — `@mongrov/core`'s logger satisfies it. */
export interface EventBusLogger {
  error: (message: string, data?: Record<string, unknown>) => void
}

/**
 * Logger for the provider and hooks (query / mutation failures, on-demand
 * fetch failures). `@mongrov/core`'s logger satisfies it.
 */
export interface DataAccessLogger extends EventBusLogger {
  warn: (message: string, data?: Record<string, unknown>) => void
}

export interface EventBusOptions {
  /**
   * Where a throwing handler is reported. Without it the report goes to
   * `console.error`, which a release build does not keep: a handler that
   * throws (and so leaves a screen stale) left no trace in an exported log.
   */
  logger?: EventBusLogger
}

export function createEventBus(options: EventBusOptions = {}): EventBus {
  const reportHandlerError = (err: unknown, name: string): void =>
    reportError(err, name, options.logger)
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

function reportError(err: unknown, name: string, logger?: EventBusLogger): void {
  // Surfaced but never propagated: one throwing subscriber must not stop
  // the rest (T-10).
  if (logger) {
    logger.error('[@mongrov/data-access] event handler threw', {
      event: name,
      error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
    })
    return
  }
  // Dev-only fallback; release has no console sink.
  if (typeof __DEV__ === 'undefined' || __DEV__)
    console.error(`[@mongrov/data-access] handler for "${name}" threw:`, err)
}
