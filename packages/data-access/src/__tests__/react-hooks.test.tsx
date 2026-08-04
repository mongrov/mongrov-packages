// @vitest-environment jsdom

import { act, cleanup, render, renderHook } from '@testing-library/react'
import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DataAccessProvider,
  createEventBus,
  DataAccessError,
  useAppEvent,
  useRequestContext,
} from '../index'
import type { EngineAdapters } from '../dispatcher'
import type { EventBus, Registry, RequestContext } from '../types'

const emptyRegistry: Registry = { queries: {}, mutations: {}, events: {} }
const noEngines: EngineAdapters = {}

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    userId: 'u1',
    brand: 'zivaone',
    familyId: 'f1',
    timezone: 'UTC',
    now: () => new Date(0),
    ...overrides,
  }
}

function wrapperWith(props: {
  bus?: EventBus
  context?: () => RequestContext
}) {
  const contextFn = props.context ?? (() => makeCtx())
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <DataAccessProvider
        registry={emptyRegistry}
        engines={noEngines}
        context={contextFn}
        bus={props.bus}
      >
        {children}
      </DataAccessProvider>
    )
  }
}

afterEach(() => {
  cleanup()
})

describe('T-16 · DataAccessProvider', () => {
  it('mints a default event bus when none is supplied', () => {
    const { result } = renderHook(() => useAppEventProbe('hrv:insert'), {
      wrapper: wrapperWith({}),
    })
    // Handler starts empty; provider must have wired *some* bus.
    expect(result.current.received).toEqual([])
  })

  it('propagates a supplied bus so external emitters reach subscribers', () => {
    const bus = createEventBus()
    const { result } = renderHook(() => useAppEventProbe<number>('hrv:insert'), {
      wrapper: wrapperWith({ bus }),
    })
    act(() => bus.emit('hrv:insert', 42))
    expect(result.current.received).toEqual([42])
  })

  it('renders children and children can consume context', () => {
    const { getByTestId } = render(
      <DataAccessProvider
        registry={emptyRegistry}
        engines={noEngines}
        context={() => makeCtx({ brand: 'ziva-two' })}
      >
        <BrandProbe />
      </DataAccessProvider>
    )
    expect(getByTestId('brand').textContent).toBe('ziva-two')
  })

  it('throws when a hook is used outside the provider', () => {
    // renderHook rethrows the render error.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        renderHook(() => useRequestContext())
      ).toThrow(DataAccessError)
    }
    finally {
      spy.mockRestore()
    }
  })
})

describe('T-17 · useRequestContext', () => {
  it('returns the value produced by the provider context factory', () => {
    const { result } = renderHook(() => useRequestContext(), {
      wrapper: wrapperWith({ context: () => makeCtx({ familyId: 'famX' }) }),
    })
    expect(result.current.familyId).toBe('famX')
    expect(result.current.brand).toBe('zivaone')
    expect(result.current.userId).toBe('u1')
    // Deprecated alias stays populated for pre-rename consumers.
    expect(result.current.requesterUserId).toBe('u1')
  })

  it('re-reads the factory on every call (session updates picked up)', () => {
    let familyId = 'first'
    const { result, rerender } = renderHook(() => useRequestContext(), {
      wrapper: wrapperWith({ context: () => makeCtx({ familyId }) }),
    })
    expect(result.current.familyId).toBe('first')
    familyId = 'second'
    rerender()
    expect(result.current.familyId).toBe('second')
  })
})

describe('T-15 · useAppEvent', () => {
  it('subscribes on mount, fires on matching emit', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    renderHook(() => useAppEvent<{ n: number }>('hrv:insert', handler), {
      wrapper: wrapperWith({ bus }),
    })
    act(() => bus.emit('hrv:insert', { n: 3 }))
    expect(handler).toHaveBeenCalledWith({ n: 3 })
  })

  it('ignores non-matching events (exact-match only)', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    renderHook(() => useAppEvent('hrv:insert', handler), {
      wrapper: wrapperWith({ bus }),
    })
    act(() => bus.emit('hrv:sync_complete', 1))
    expect(handler).not.toHaveBeenCalled()
  })

  it('unsubscribes on unmount', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    const { unmount } = renderHook(() => useAppEvent('hrv:insert', handler), {
      wrapper: wrapperWith({ bus }),
    })
    act(() => bus.emit('hrv:insert', 1))
    expect(handler).toHaveBeenCalledTimes(1)
    unmount()
    act(() => bus.emit('hrv:insert', 2))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('picks up new handler identity without resubscribing', () => {
    const bus = createEventBus()
    const first = vi.fn()
    const second = vi.fn()

    const { rerender } = renderHook(
      ({ h }: { h: (p: unknown) => void }) => useAppEvent('hrv:insert', h),
      { wrapper: wrapperWith({ bus }), initialProps: { h: first } }
    )
    act(() => bus.emit('hrv:insert', 'a'))
    expect(first).toHaveBeenCalledWith('a')

    rerender({ h: second })
    act(() => bus.emit('hrv:insert', 'b'))
    expect(second).toHaveBeenCalledWith('b')
    // First handler must not be invoked with the second event.
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('resubscribes when the event name changes', () => {
    const bus = createEventBus()
    const handler = vi.fn()

    const { rerender } = renderHook(
      ({ name }: { name: string }) => useAppEvent(name, handler),
      {
        wrapper: wrapperWith({ bus }),
        initialProps: { name: 'hrv:insert' },
      }
    )
    act(() => bus.emit('hrv:insert', 1))
    expect(handler).toHaveBeenCalledWith(1)

    rerender({ name: 'sleep:insert' })
    act(() => bus.emit('hrv:insert', 2))
    // Old subscription gone.
    expect(handler).toHaveBeenCalledTimes(1)
    act(() => bus.emit('sleep:insert', 3))
    expect(handler).toHaveBeenCalledWith(3)
  })
})

// --- helpers -----------------------------------------------------------

function BrandProbe() {
  const ctx = useRequestContext()
  return <span data-testid="brand">{ctx.brand}</span>
}

function useAppEventProbe<T>(name: string) {
  const [received, setReceived] = React.useState<T[]>([])
  useAppEvent<T>(name, (payload) => {
    setReceived((prev) => [...prev, payload])
  })
  return { received }
}
