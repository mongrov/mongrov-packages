/**
 * Minimal typed event emitter for the rules engine.
 *
 * Only the `'violation'` event is supported. Handler exceptions are
 * caught and logged so a single subscriber can't take down evaluation.
 * `on(...)` returns an `Unsubscribe` closure per spec's public surface.
 */

import type { Unsubscribe } from '../core/types'
import type { RulesLogger, RuleViolation } from './types'
import { describeError } from '../core/errors'

type ViolationHandler = (v: RuleViolation) => void

export interface RulesEmitter {
  on: (event: 'violation', handler: ViolationHandler) => Unsubscribe
  emit: (event: 'violation', payload: RuleViolation) => void
  /** Drop every subscriber. Idempotent. Used by `RulesEngine.close()`. */
  close: () => void
}

export interface CreateEmitterConfig {
  logger?: RulesLogger
}

export function createEmitter({ logger }: CreateEmitterConfig = {}): RulesEmitter {
  const handlers = new Set<ViolationHandler>()

  return {
    on(_event, handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    emit(_event, payload) {
      for (const h of handlers) {
        try {
          h(payload)
        }
        catch (err) {
          logger?.error('rules.emitter: violation handler threw', {
            err: describeError(err),
            ruleId: payload.ruleId,
          })
        }
      }
    },
    close() {
      handlers.clear()
    },
  }
}
