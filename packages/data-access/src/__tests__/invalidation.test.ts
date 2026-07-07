import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DataAccessError } from '../errors'
import { compileGlob, createEventBus } from '../invalidation'

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('createEventBus — exact subscribe (mitt smoke)', () => {
  it('subscribe → emit → handler fires with the correct payload', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    bus.subscribe<{ rows: number }>('hrv:insert', handler)
    bus.emit('hrv:insert', { rows: 12 })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ rows: 12 })
  })

  it('unsubscribe closure stops future deliveries', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    const off = bus.subscribe('hrv:insert', handler)
    bus.emit('hrv:insert', 1)
    off()
    bus.emit('hrv:insert', 2)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('non-matching names are ignored', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    bus.subscribe('hrv:insert', handler)
    bus.emit('sleep:insert', 1)
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects empty event names on subscribe', () => {
    const bus = createEventBus()
    expect(() => bus.subscribe('', () => {})).toThrow(DataAccessError)
  })
})

describe('createEventBus — subscribePattern (glob matching matrix)', () => {
  // The full matrix from spec.md §Invalidation event bus.
  // Rows: pattern. Columns: event names. Value: expected match?
  const events = [
    'hrv:insert',
    'hrv:sync_complete',
    'hrv_baseline:insert',
    'sleep:stage:insert',
    'insight:insert',
  ] as const

  type MatrixRow = [string, boolean, boolean, boolean, boolean, boolean]

  const matrix: MatrixRow[] = [
    // pattern           hrv:insert hrv:sync_complete hrv_baseline:insert sleep:stage:insert insight:insert
    ['hrv:insert',       true,      false,            false,              false,             false],
    ['hrv:*',            true,      true,             false,              false,             false],
    ['*:insert',         true,      false,            true,               false,             true],
    ['sleep:**',         false,     false,            false,              true,              false],
    ['**',               true,      true,             true,               true,              true],
  ]

  for (const [pattern, ...expected] of matrix) {
    events.forEach((name, i) => {
      const should = expected[i]
      it(`pattern ${JSON.stringify(pattern)} ${should ? 'matches' : 'ignores'} ${JSON.stringify(name)}`, () => {
        const bus = createEventBus()
        const handler = vi.fn()
        bus.subscribePattern(pattern, handler)
        bus.emit(name, { i })
        if (should) {
          expect(handler).toHaveBeenCalledWith(name, { i })
        }
        else {
          expect(handler).not.toHaveBeenCalled()
        }
      })
    })
  }

  it('** vs * boundary: `hrv:*` does not match `hrv:stage:insert`', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    bus.subscribePattern('hrv:*', handler)
    bus.emit('hrv:stage:insert', 1)
    expect(handler).not.toHaveBeenCalled()
  })

  it('is case-sensitive', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    bus.subscribePattern('HRV:*', handler)
    bus.emit('hrv:insert', 1)
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects empty pattern', () => {
    const bus = createEventBus()
    expect(() => bus.subscribePattern('', () => {})).toThrow(DataAccessError)
  })

  it('rejects empty segments (e.g. `hrv::insert`)', () => {
    const bus = createEventBus()
    expect(() => bus.subscribePattern('hrv::insert', () => {})).toThrow(
      /empty segment/
    )
  })

  it('unsubscribe closure removes pattern subscription', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    const off = bus.subscribePattern('hrv:*', handler)
    bus.emit('hrv:insert', 1)
    off()
    bus.emit('hrv:sync_complete', 2)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('escapes regex metacharacters in literal segments', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    // `+` is a regex quantifier; must be treated literally by compileGlob.
    // Unescaped, `hrv+plus` would match `hrvvvplus` — with escaping it does not.
    bus.subscribePattern('hrv+plus:insert', handler)
    bus.emit('hrv+plus:insert', 1)
    bus.emit('hrvvvplus:insert', 2)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('hrv+plus:insert', 1)
  })
})

describe('T-10 — handler isolation', () => {
  it('exact-subscriber throw does not stop other exact subscribers', () => {
    const bus = createEventBus()
    const bad = vi.fn(() => {
      throw new Error('boom')
    })
    const good = vi.fn()
    bus.subscribe('hrv:insert', bad)
    bus.subscribe('hrv:insert', good)
    bus.emit('hrv:insert', 1)
    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalled()
  })

  it('exact-subscriber throw does not stop pattern subscribers', () => {
    const bus = createEventBus()
    const bad = vi.fn(() => {
      throw new Error('boom')
    })
    const pattern = vi.fn()
    bus.subscribe('hrv:insert', bad)
    bus.subscribePattern('hrv:*', pattern)
    bus.emit('hrv:insert', 1)
    expect(bad).toHaveBeenCalledTimes(1)
    expect(pattern).toHaveBeenCalledTimes(1)
  })

  it('pattern-subscriber throw does not stop other pattern subscribers', () => {
    const bus = createEventBus()
    const bad = vi.fn(() => {
      throw new Error('boom')
    })
    const good = vi.fn()
    bus.subscribePattern('**', bad)
    bus.subscribePattern('hrv:*', good)
    bus.emit('hrv:insert', 1)
    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)
  })
})

describe('compileGlob (unit)', () => {
  it('exact match', () => {
    expect(compileGlob('hrv:insert').test('hrv:insert')).toBe(true)
    expect(compileGlob('hrv:insert').test('hrv:sync_complete')).toBe(false)
  })

  it('* matches one segment only', () => {
    const rx = compileGlob('*:insert')
    expect(rx.test('hrv:insert')).toBe(true)
    expect(rx.test('sleep:stage:insert')).toBe(false)
  })

  it('** matches one or more segments', () => {
    const rx = compileGlob('sleep:**')
    expect(rx.test('sleep:insert')).toBe(true)
    expect(rx.test('sleep:stage:insert')).toBe(true)
  })
})
