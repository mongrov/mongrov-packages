import type { RuleViolation } from '../types'
import { describe, expect, it, vi } from 'vitest'
import { createEmitter } from '../emitter'

const sampleViolation: RuleViolation = {
  ruleId: 'test.rule',
  ruleName: 'Test',
  severity: 'warn',
  userId: 'u1',
  familyId: 'f1',
  brand: 'ziva',
  observedValue: 30,
  thresholdValue: 40,
  observedAt: new Date('2025-01-01T00:00:00Z'),
  evidence: {},
}

describe('createEmitter', () => {
  it('delivers to every subscriber', () => {
    const emitter = createEmitter()
    const a = vi.fn()
    const b = vi.fn()
    emitter.on('violation', a)
    emitter.on('violation', b)
    emitter.emit('violation', sampleViolation)
    expect(a).toHaveBeenCalledWith(sampleViolation)
    expect(b).toHaveBeenCalledWith(sampleViolation)
  })

  it('unsubscribe removes the handler', () => {
    const emitter = createEmitter()
    const handler = vi.fn()
    const unsub = emitter.on('violation', handler)
    unsub()
    emitter.emit('violation', sampleViolation)
    expect(handler).not.toHaveBeenCalled()
  })

  it('handler exceptions are logged, do not break other handlers', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const emitter = createEmitter({ logger })
    const bad = () => {
      throw new Error('boom')
    }
    const good = vi.fn()
    emitter.on('violation', bad)
    emitter.on('violation', good)
    emitter.emit('violation', sampleViolation)
    expect(good).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalled()
  })
})
