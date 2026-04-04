/**
 * Tests for @mongrov/collab
 */

import { createActor, waitFor } from 'xstate'
import { collabMachine, getConnectionStatus, createMachineInput } from '../machine'
import { BaseAdapter } from '../adapters/base'
import { MockAdapter } from './mock-adapter'
import type { CollabConfig } from '../types'

// ─── Machine Tests ──────────────────────────────────────────────────────────

describe('collabMachine', () => {
  let adapter: MockAdapter

  beforeEach(() => {
    adapter = new MockAdapter()
  })

  afterEach(() => {
    adapter.reset()
  })

  it('should start in disconnected state', () => {
    const actor = createActor(collabMachine, {
      input: { adapter },
    })
    actor.start()

    expect(actor.getSnapshot().value).toBe('disconnected')

    actor.stop()
  })

  it('should transition to connecting on CONNECT', () => {
    const actor = createActor(collabMachine, {
      input: { adapter },
    })
    actor.start()

    actor.send({
      type: 'CONNECT',
      credentials: { serverUrl: 'wss://test.com' },
    })

    expect(actor.getSnapshot().value).toBe('connecting')

    actor.stop()
  })

  it('should transition to connected after successful connect', async () => {
    const actor = createActor(collabMachine, {
      input: { adapter },
    })
    actor.start()

    actor.send({
      type: 'CONNECT',
      credentials: { serverUrl: 'wss://test.com' },
    })

    await waitFor(actor, (state) => state.value === 'connected')

    expect(actor.getSnapshot().value).toBe('connected')
    expect(adapter.connectCalls).toHaveLength(1)

    actor.stop()
  })

  it('should transition to error on connect failure', async () => {
    adapter.shouldFailConnect = true

    const actor = createActor(collabMachine, {
      input: { adapter },
    })
    actor.start()

    actor.send({
      type: 'CONNECT',
      credentials: { serverUrl: 'wss://test.com' },
    })

    await waitFor(actor, (state) => state.value === 'error')

    expect(actor.getSnapshot().value).toBe('error')
    expect(actor.getSnapshot().context.error).toBeTruthy()

    actor.stop()
  })

  it('should transition to disconnected on DISCONNECT', async () => {
    const actor = createActor(collabMachine, {
      input: { adapter },
    })
    actor.start()

    // Connect first
    actor.send({
      type: 'CONNECT',
      credentials: { serverUrl: 'wss://test.com' },
    })
    await waitFor(actor, (state) => state.value === 'connected')

    // Then disconnect
    actor.send({ type: 'DISCONNECT' })
    await waitFor(actor, (state) => state.value === 'disconnected')

    expect(actor.getSnapshot().value).toBe('disconnected')
    expect(adapter.disconnectCalls).toBe(1)

    actor.stop()
  })

  it('should store credentials in context', async () => {
    const actor = createActor(collabMachine, {
      input: { adapter },
    })
    actor.start()

    const credentials = { serverUrl: 'wss://test.com', token: 'abc123' }
    actor.send({ type: 'CONNECT', credentials })

    await waitFor(actor, (state) => state.value === 'connected')

    expect(actor.getSnapshot().context.credentials).toEqual(credentials)

    actor.stop()
  })

  it('should clear error on successful reconnect', async () => {
    adapter.shouldFailConnect = true

    const actor = createActor(collabMachine, {
      input: { adapter },
    })
    actor.start()

    // First attempt fails
    actor.send({
      type: 'CONNECT',
      credentials: { serverUrl: 'wss://test.com' },
    })
    await waitFor(actor, (state) => state.value === 'error')

    expect(actor.getSnapshot().context.error).toBeTruthy()

    // Fix the adapter and retry
    adapter.shouldFailConnect = false
    actor.send({
      type: 'CONNECT',
      credentials: { serverUrl: 'wss://test.com' },
    })
    await waitFor(actor, (state) => state.value === 'connected')

    expect(actor.getSnapshot().context.error).toBeNull()

    actor.stop()
  })
})

// ─── getConnectionStatus Tests ──────────────────────────────────────────────

describe('getConnectionStatus', () => {
  it('should map disconnected state', () => {
    expect(getConnectionStatus('disconnected')).toBe('disconnected')
  })

  it('should map connecting state', () => {
    expect(getConnectionStatus('connecting')).toBe('connecting')
  })

  it('should map connected state', () => {
    expect(getConnectionStatus('connected')).toBe('connected')
  })

  it('should map reconnecting state', () => {
    expect(getConnectionStatus('reconnecting')).toBe('reconnecting')
  })

  it('should map error state', () => {
    expect(getConnectionStatus('error')).toBe('error')
  })

  it('should default to disconnected for unknown state', () => {
    expect(getConnectionStatus('unknown')).toBe('disconnected')
  })
})

// ─── createMachineInput Tests ───────────────────────────────────────────────

describe('createMachineInput', () => {
  it('should use default values', () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = { adapter }

    const input = createMachineInput(config)

    expect(input.adapter).toBe(adapter)
    expect(input.maxReconnectAttempts).toBe(10)
    expect(input.baseDelay).toBe(1000)
    expect(input.maxDelay).toBe(30000)
  })

  it('should use custom reconnect settings', () => {
    const adapter = new MockAdapter()
    const config: CollabConfig = {
      adapter,
      reconnect: {
        maxAttempts: 5,
        baseDelay: 500,
        maxDelay: 10000,
      },
    }

    const input = createMachineInput(config)

    expect(input.maxReconnectAttempts).toBe(5)
    expect(input.baseDelay).toBe(500)
    expect(input.maxDelay).toBe(10000)
  })

  it('should pass through logger', () => {
    const adapter = new MockAdapter()
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }
    const config: CollabConfig = { adapter, logger }

    const input = createMachineInput(config)

    expect(input.logger).toBe(logger)
  })
})

// ─── BaseAdapter Tests ──────────────────────────────────────────────────────

describe('BaseAdapter', () => {
  let adapter: MockAdapter

  beforeEach(() => {
    adapter = new MockAdapter()
  })

  it('should emit events to subscribers', () => {
    const handler = jest.fn()
    adapter.on('connection:connected', handler)

    adapter.emit('connection:connected', undefined)

    expect(handler).toHaveBeenCalled()
  })

  it('should support multiple subscribers', () => {
    const handler1 = jest.fn()
    const handler2 = jest.fn()

    adapter.on('connection:connected', handler1)
    adapter.on('connection:connected', handler2)

    adapter.emit('connection:connected', undefined)

    expect(handler1).toHaveBeenCalled()
    expect(handler2).toHaveBeenCalled()
  })

  it('should unsubscribe correctly', () => {
    const handler = jest.fn()
    const unsubscribe = adapter.on('connection:connected', handler)

    unsubscribe()
    adapter.emit('connection:connected', undefined)

    expect(handler).not.toHaveBeenCalled()
  })

  it('should pass payload to handler', () => {
    const handler = jest.fn()
    adapter.on('connection:error', handler)

    const error = new Error('Test error')
    adapter.emit('connection:error', { error })

    expect(handler).toHaveBeenCalledWith({ error })
  })

  it('should track status changes', async () => {
    expect(adapter.status).toBe('disconnected')

    await adapter.connect({ serverUrl: 'test' })

    expect(adapter.status).toBe('connected')

    await adapter.disconnect()

    expect(adapter.status).toBe('disconnected')
  })
})

// ─── MockAdapter Tests ──────────────────────────────────────────────────────

describe('MockAdapter', () => {
  let adapter: MockAdapter

  beforeEach(() => {
    adapter = new MockAdapter()
  })

  afterEach(() => {
    adapter.reset()
  })

  it('should track connect calls', async () => {
    await adapter.connect({ serverUrl: 'test', token: 'abc' })

    expect(adapter.connectCalls).toHaveLength(1)
    expect(adapter.connectCalls[0]).toEqual({ serverUrl: 'test', token: 'abc' })
  })

  it('should track sendMessage calls', async () => {
    await adapter.connect({ serverUrl: 'test' })

    await adapter.sendMessage({
      conversationId: 'conv-1',
      content: { type: 'text', text: 'Hello' },
    })

    expect(adapter.sendMessageCalls).toHaveLength(1)
    expect(adapter.sendMessageCalls[0].conversationId).toBe('conv-1')
  })

  it('should simulate connection failure', async () => {
    adapter.shouldFailConnect = true

    await expect(adapter.connect({ serverUrl: 'test' })).rejects.toThrow(
      'Mock connection failed'
    )
    expect(adapter.status).toBe('error')
  })

  it('should simulate incoming messages', () => {
    const handler = jest.fn()
    adapter.on('message:received', handler)

    const message = {
      id: 'msg-1',
      conversationId: 'conv-1',
      sender: { id: 'user-1', name: 'User', type: 'human' as const },
      content: { type: 'text' as const, text: 'Hello' },
      deliveryStatus: 'sent' as const,
      createdAt: new Date().toISOString(),
    }

    adapter.simulateIncomingMessage(message)

    expect(handler).toHaveBeenCalledWith(message)
  })

  it('should reset state', async () => {
    await adapter.connect({ serverUrl: 'test' })
    await adapter.sendMessage({
      conversationId: 'conv-1',
      content: { type: 'text', text: 'Hello' },
    })

    adapter.reset()

    expect(adapter.connectCalls).toHaveLength(0)
    expect(adapter.sendMessageCalls).toHaveLength(0)
    expect(adapter.status).toBe('disconnected')
  })
})
