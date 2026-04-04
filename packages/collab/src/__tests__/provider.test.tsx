/**
 * Tests for CollabProvider and hooks
 */

import React from 'react'
import { render, screen, act, waitFor, renderHook } from '@testing-library/react'
import { CollabProvider, useCollab, useTyping, useMessages, usePresence } from '../provider'
import { MockAdapter } from './mock-adapter'
import type { CollabConfig } from '../types'
import type { Message } from '@mongrov/types'

// ─── Test Utilities ──────────────────────────────────────────────────────────

function createTestConfig(overrides?: Partial<CollabConfig>): CollabConfig {
  return {
    adapter: new MockAdapter(),
    ...overrides,
  }
}

function TestComponent({ onRender }: { onRender?: (value: ReturnType<typeof useCollab>) => void }) {
  const collab = useCollab()
  onRender?.(collab)
  return (
    <div>
      <span data-testid="status">{collab.status}</span>
      <span data-testid="isConnected">{collab.isConnected.toString()}</span>
      <span data-testid="isConnecting">{collab.isConnecting.toString()}</span>
    </div>
  )
}

// ─── CollabProvider Tests ────────────────────────────────────────────────────

describe('CollabProvider', () => {
  it('should render children', () => {
    const config = createTestConfig()

    render(
      <CollabProvider config={config}>
        <div data-testid="child">Hello</div>
      </CollabProvider>
    )

    expect(screen.getByTestId('child').textContent).toBe('Hello')
  })

  it('should provide initial disconnected status', () => {
    const config = createTestConfig()

    render(
      <CollabProvider config={config}>
        <TestComponent />
      </CollabProvider>
    )

    expect(screen.getByTestId('status').textContent).toBe('disconnected')
    expect(screen.getByTestId('isConnected').textContent).toBe('false')
    expect(screen.getByTestId('isConnecting').textContent).toBe('false')
  })

  it('should provide adapter in context', () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }
    let capturedAdapter: MockAdapter | undefined

    render(
      <CollabProvider config={config}>
        <TestComponent onRender={(value) => { capturedAdapter = value.adapter as MockAdapter }} />
      </CollabProvider>
    )

    expect(capturedAdapter).toBe(adapter)
  })
})

// ─── useCollab Tests ─────────────────────────────────────────────────────────

describe('useCollab', () => {
  it('should throw when used outside provider', () => {
    // Suppress console.error for this test
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => {
      renderHook(() => useCollab())
    }).toThrow('[useCollab] Hook called outside of CollabProvider')

    consoleSpy.mockRestore()
  })

  it('should update status on connect', async () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }

    const { result } = renderHook(() => useCollab(), {
      wrapper: ({ children }) => (
        <CollabProvider config={config}>{children}</CollabProvider>
      ),
    })

    expect(result.current.status).toBe('disconnected')

    await act(async () => {
      result.current.connect({ serverUrl: 'wss://test.com' })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('connected')
    })

    expect(result.current.isConnected).toBe(true)
    expect(result.current.isConnecting).toBe(false)
  })

  it('should disconnect correctly', async () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }

    const { result } = renderHook(() => useCollab(), {
      wrapper: ({ children }) => (
        <CollabProvider config={config}>{children}</CollabProvider>
      ),
    })

    // Connect first
    await act(async () => {
      result.current.connect({ serverUrl: 'wss://test.com' })
    })

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true)
    })

    // Disconnect
    await act(async () => {
      result.current.disconnect()
    })

    await waitFor(() => {
      expect(result.current.status).toBe('disconnected')
    })

    expect(result.current.isConnected).toBe(false)
  })

  it('should call adapter methods through context', async () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }

    const { result } = renderHook(() => useCollab(), {
      wrapper: ({ children }) => (
        <CollabProvider config={config}>{children}</CollabProvider>
      ),
    })

    // Connect
    await act(async () => {
      result.current.connect({ serverUrl: 'wss://test.com' })
    })

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true)
    })

    // Send message
    await act(async () => {
      await result.current.sendMessage({
        conversationId: 'conv-1',
        content: { type: 'text', text: 'Hello' },
      })
    })

    expect(adapter.sendMessageCalls).toHaveLength(1)
    expect(adapter.sendMessageCalls[0].conversationId).toBe('conv-1')

    // Send typing
    await act(async () => {
      await result.current.sendTyping('conv-1', true)
    })

    expect(adapter.sendTypingCalls).toHaveLength(1)
    expect(adapter.sendTypingCalls[0]).toEqual({ conversationId: 'conv-1', isTyping: true })

    // Set presence
    await act(async () => {
      await result.current.setPresence('online')
    })

    expect(adapter.presenceCalls).toHaveLength(1)
    expect(adapter.presenceCalls[0]).toBe('online')
  })

  it('should expose event subscription', async () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }
    const handler = jest.fn()

    const { result } = renderHook(() => useCollab(), {
      wrapper: ({ children }) => (
        <CollabProvider config={config}>{children}</CollabProvider>
      ),
    })

    const unsubscribe = result.current.on('message:received', handler)

    const message: Message = {
      id: 'msg-1',
      conversationId: 'conv-1',
      sender: { id: 'user-1', name: 'User', type: 'human' },
      content: { type: 'text', text: 'Hello' },
      deliveryStatus: 'sent',
      createdAt: new Date().toISOString(),
    }

    act(() => {
      adapter.simulateIncomingMessage(message)
    })

    expect(handler).toHaveBeenCalledWith(message)

    // Test unsubscribe
    unsubscribe()
    handler.mockClear()

    act(() => {
      adapter.simulateIncomingMessage(message)
    })

    expect(handler).not.toHaveBeenCalled()
  })
})

// ─── useTyping Tests ─────────────────────────────────────────────────────────

describe('useTyping', () => {
  it('should track typing users', async () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }

    const { result } = renderHook(() => {
      const collab = useCollab()
      const typing = useTyping('conv-1')
      return { collab, typing }
    }, {
      wrapper: ({ children }) => (
        <CollabProvider config={config}>{children}</CollabProvider>
      ),
    })

    // Connect first
    await act(async () => {
      result.current.collab.connect({ serverUrl: 'wss://test.com' })
    })

    await waitFor(() => {
      expect(result.current.collab.isConnected).toBe(true)
    })

    expect(result.current.typing.typingUsers).toHaveLength(0)

    // Simulate typing start
    act(() => {
      adapter.simulateTypingStart('conv-1', 'user-1', 'User One')
    })

    await waitFor(() => {
      expect(result.current.typing.typingUsers).toHaveLength(1)
    })

    expect(result.current.typing.typingUsers[0].userId).toBe('user-1')
    expect(result.current.typing.typingUsers[0].userName).toBe('User One')

    // Simulate typing stop
    act(() => {
      adapter.simulateTypingStop('conv-1', 'user-1')
    })

    await waitFor(() => {
      expect(result.current.typing.typingUsers).toHaveLength(0)
    })
  })

  it('should filter typing events by conversation', async () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }

    const { result } = renderHook(() => {
      const collab = useCollab()
      const typing = useTyping('conv-1')
      return { collab, typing }
    }, {
      wrapper: ({ children }) => (
        <CollabProvider config={config}>{children}</CollabProvider>
      ),
    })

    await act(async () => {
      result.current.collab.connect({ serverUrl: 'wss://test.com' })
    })

    await waitFor(() => {
      expect(result.current.collab.isConnected).toBe(true)
    })

    // Typing in a different conversation should be ignored
    act(() => {
      adapter.simulateTypingStart('conv-2', 'user-1', 'User One')
    })

    // Small delay to ensure event processed
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(result.current.typing.typingUsers).toHaveLength(0)
  })

  it('should call sendTyping on adapter', async () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }

    const { result } = renderHook(() => {
      const collab = useCollab()
      const typing = useTyping('conv-1')
      return { collab, typing }
    }, {
      wrapper: ({ children }) => (
        <CollabProvider config={config}>{children}</CollabProvider>
      ),
    })

    await act(async () => {
      result.current.collab.connect({ serverUrl: 'wss://test.com' })
    })

    await waitFor(() => {
      expect(result.current.collab.isConnected).toBe(true)
    })

    act(() => {
      result.current.typing.sendTyping(true)
    })

    expect(adapter.sendTypingCalls).toHaveLength(1)
    expect(adapter.sendTypingCalls[0]).toEqual({ conversationId: 'conv-1', isTyping: true })
  })

  it('should auto-remove typing user after timeout', async () => {
    jest.useFakeTimers()
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }

    const { result } = renderHook(() => {
      const collab = useCollab()
      const typing = useTyping('conv-1')
      return { collab, typing }
    }, {
      wrapper: ({ children }) => (
        <CollabProvider config={config}>{children}</CollabProvider>
      ),
    })

    await act(async () => {
      result.current.collab.connect({ serverUrl: 'wss://test.com' })
    })

    await waitFor(() => {
      expect(result.current.collab.isConnected).toBe(true)
    })

    act(() => {
      adapter.simulateTypingStart('conv-1', 'user-1', 'User One')
    })

    expect(result.current.typing.typingUsers).toHaveLength(1)

    // Fast-forward 5 seconds
    act(() => {
      jest.advanceTimersByTime(5000)
    })

    expect(result.current.typing.typingUsers).toHaveLength(0)

    jest.useRealTimers()
  })
})

// ─── useMessages Tests ───────────────────────────────────────────────────────

describe('useMessages', () => {
  it('should start in loading state', async () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }

    const { result } = renderHook(() => {
      const collab = useCollab()
      const messages = useMessages('conv-1')
      return { collab, messages }
    }, {
      wrapper: ({ children }) => (
        <CollabProvider config={config}>{children}</CollabProvider>
      ),
    })

    // Not connected yet, should be loading false
    expect(result.current.messages.isLoading).toBe(false)
  })

  it('should fetch messages on connect', async () => {
    const adapter = new MockAdapter()

    // Pre-populate some messages
    const existingMessage: Message = {
      id: 'msg-1',
      conversationId: 'conv-1',
      sender: { id: 'user-1', name: 'User', type: 'human' },
      content: { type: 'text', text: 'Hello' },
      deliveryStatus: 'sent',
      createdAt: new Date().toISOString(),
    }
    adapter.messages = [existingMessage]

    const config: CollabConfig = { adapter }

    const { result } = renderHook(() => {
      const collab = useCollab()
      const messages = useMessages('conv-1')
      return { collab, messages }
    }, {
      wrapper: ({ children }) => (
        <CollabProvider config={config}>{children}</CollabProvider>
      ),
    })

    await act(async () => {
      result.current.collab.connect({ serverUrl: 'wss://test.com' })
    })

    await waitFor(() => {
      expect(result.current.collab.isConnected).toBe(true)
    })

    await waitFor(() => {
      expect(result.current.messages.isLoading).toBe(false)
    })

    expect(result.current.messages.messages).toHaveLength(1)
    expect(result.current.messages.messages[0].id).toBe('msg-1')
  })

  it('should receive new messages in real-time', async () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }

    const { result } = renderHook(() => {
      const collab = useCollab()
      const messages = useMessages('conv-1')
      return { collab, messages }
    }, {
      wrapper: ({ children }) => (
        <CollabProvider config={config}>{children}</CollabProvider>
      ),
    })

    await act(async () => {
      result.current.collab.connect({ serverUrl: 'wss://test.com' })
    })

    await waitFor(() => {
      expect(result.current.collab.isConnected).toBe(true)
    })

    await waitFor(() => {
      expect(result.current.messages.isLoading).toBe(false)
    })

    const newMessage: Message = {
      id: 'msg-new',
      conversationId: 'conv-1',
      sender: { id: 'user-2', name: 'User Two', type: 'human' },
      content: { type: 'text', text: 'New message' },
      deliveryStatus: 'sent',
      createdAt: new Date().toISOString(),
    }

    act(() => {
      adapter.simulateIncomingMessage(newMessage)
    })

    await waitFor(() => {
      expect(result.current.messages.messages).toContainEqual(expect.objectContaining({ id: 'msg-new' }))
    })
  })

  it('should deduplicate messages', async () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }

    const { result } = renderHook(() => {
      const collab = useCollab()
      const messages = useMessages('conv-1')
      return { collab, messages }
    }, {
      wrapper: ({ children }) => (
        <CollabProvider config={config}>{children}</CollabProvider>
      ),
    })

    await act(async () => {
      result.current.collab.connect({ serverUrl: 'wss://test.com' })
    })

    await waitFor(() => {
      expect(result.current.collab.isConnected).toBe(true)
    })

    await waitFor(() => {
      expect(result.current.messages.isLoading).toBe(false)
    })

    const message: Message = {
      id: 'msg-dup',
      conversationId: 'conv-1',
      sender: { id: 'user-1', name: 'User', type: 'human' },
      content: { type: 'text', text: 'Duplicate test' },
      deliveryStatus: 'sent',
      createdAt: new Date().toISOString(),
    }

    // Send same message twice
    act(() => {
      adapter.simulateIncomingMessage(message)
    })

    await waitFor(() => {
      expect(result.current.messages.messages).toHaveLength(1)
    })

    act(() => {
      adapter.simulateIncomingMessage(message)
    })

    // Should still be 1 message
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(result.current.messages.messages.filter(m => m.id === 'msg-dup')).toHaveLength(1)
  })

  it('should filter messages by conversation', async () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }

    const { result } = renderHook(() => {
      const collab = useCollab()
      const messages = useMessages('conv-1')
      return { collab, messages }
    }, {
      wrapper: ({ children }) => (
        <CollabProvider config={config}>{children}</CollabProvider>
      ),
    })

    await act(async () => {
      result.current.collab.connect({ serverUrl: 'wss://test.com' })
    })

    await waitFor(() => {
      expect(result.current.collab.isConnected).toBe(true)
    })

    await waitFor(() => {
      expect(result.current.messages.isLoading).toBe(false)
    })

    // Message for different conversation should be ignored
    const otherMessage: Message = {
      id: 'msg-other',
      conversationId: 'conv-2',
      sender: { id: 'user-1', name: 'User', type: 'human' },
      content: { type: 'text', text: 'Wrong conv' },
      deliveryStatus: 'sent',
      createdAt: new Date().toISOString(),
    }

    act(() => {
      adapter.simulateIncomingMessage(otherMessage)
    })

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(result.current.messages.messages).toHaveLength(0)
  })

  it('should call refresh correctly', async () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }

    const { result } = renderHook(() => {
      const collab = useCollab()
      const messages = useMessages('conv-1')
      return { collab, messages }
    }, {
      wrapper: ({ children }) => (
        <CollabProvider config={config}>{children}</CollabProvider>
      ),
    })

    await act(async () => {
      result.current.collab.connect({ serverUrl: 'wss://test.com' })
    })

    await waitFor(() => {
      expect(result.current.collab.isConnected).toBe(true)
    })

    await waitFor(() => {
      expect(result.current.messages.isLoading).toBe(false)
    })

    // Add messages to adapter
    adapter.messages = [{
      id: 'msg-refreshed',
      conversationId: 'conv-1',
      sender: { id: 'user-1', name: 'User', type: 'human' },
      content: { type: 'text', text: 'After refresh' },
      deliveryStatus: 'sent',
      createdAt: new Date().toISOString(),
    }]

    await act(async () => {
      await result.current.messages.refresh()
    })

    expect(result.current.messages.messages).toHaveLength(1)
    expect(result.current.messages.messages[0].id).toBe('msg-refreshed')
  })
})

// ─── usePresence Tests ───────────────────────────────────────────────────────

describe('usePresence', () => {
  it('should start with empty presence map', async () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }

    const { result } = renderHook(() => {
      const collab = useCollab()
      const presence = usePresence(['user-1', 'user-2'])
      return { collab, presence }
    }, {
      wrapper: ({ children }) => (
        <CollabProvider config={config}>{children}</CollabProvider>
      ),
    })

    expect(result.current.presence.presence.size).toBe(0)
  })

  it('should not be loading when not connected', () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }

    const { result } = renderHook(() => {
      const collab = useCollab()
      const presence = usePresence(['user-1'])
      return { collab, presence }
    }, {
      wrapper: ({ children }) => (
        <CollabProvider config={config}>{children}</CollabProvider>
      ),
    })

    expect(result.current.presence.isLoading).toBe(false)
  })

  it('should update on presence change', async () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }

    const { result } = renderHook(() => {
      const collab = useCollab()
      const presence = usePresence(['user-1'])
      return { collab, presence }
    }, {
      wrapper: ({ children }) => (
        <CollabProvider config={config}>{children}</CollabProvider>
      ),
    })

    await act(async () => {
      result.current.collab.connect({ serverUrl: 'wss://test.com' })
    })

    await waitFor(() => {
      expect(result.current.collab.isConnected).toBe(true)
    })

    await waitFor(() => {
      expect(result.current.presence.isLoading).toBe(false)
    })

    act(() => {
      adapter.emit('presence:changed', { userId: 'user-1', status: 'online' })
    })

    await waitFor(() => {
      expect(result.current.presence.presence.get('user-1')?.status).toBe('online')
    })
  })
})
