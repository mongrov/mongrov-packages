/**
 * Integration tests for Collab + DB sync scenarios
 *
 * These tests verify that the collab adapter properly integrates with
 * database replication patterns used by the @mongrov/db package.
 */

import { MockAdapter } from './mock-adapter'
import type { Message, Participant } from '@mongrov/types'

// Simulated replication state that mirrors @mongrov/db replication patterns
interface MockReplicationState {
  messages: Message[]
  pullHandler: (checkpoint: unknown, batchSize: number) => Promise<{ documents: Message[]; checkpoint: unknown }>
  pushHandler: (docs: Message[]) => Promise<void>
}

/**
 * Creates a mock replication state that simulates the db package's sync mechanism
 */
function createMockReplicationState(): MockReplicationState {
  const messages: Message[] = []

  return {
    messages,
    pullHandler: async (_checkpoint: unknown, _batchSize: number) => {
      return {
        documents: messages,
        checkpoint: messages.length > 0 ? { ts: Date.now() } : null,
      }
    },
    pushHandler: async (docs: Message[]) => {
      // Simulate pushing to remote - add to messages array
      docs.forEach((doc) => {
        const existingIndex = messages.findIndex((m) => m.id === doc.id)
        if (existingIndex >= 0) {
          messages[existingIndex] = doc
        } else {
          messages.push(doc)
        }
      })
    },
  }
}

/**
 * Creates a test message with default values
 */
function createTestMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Date.now()}`,
    conversationId: 'conv-1',
    sender: { id: 'user-1', name: 'Test User', type: 'human' } as Participant,
    content: 'Test message content',
    deliveryStatus: 'sent',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('Collab + DB Integration', () => {
  let adapter: MockAdapter
  let replicationState: MockReplicationState

  beforeEach(() => {
    adapter = new MockAdapter()
    replicationState = createMockReplicationState()
  })

  afterEach(() => {
    adapter.reset()
  })

  describe('Message Reception Flow', () => {
    it('should receive message from adapter and sync to replication state', async () => {
      // Set up listener for incoming messages
      const receivedMessages: Message[] = []
      adapter.on('message:received', (message: Message) => {
        receivedMessages.push(message)
        // Simulate db replication push when message received
        replicationState.pushHandler([message])
      })

      // Connect adapter
      await adapter.connect({ userId: 'user-1', token: 'test-token' })

      // Simulate incoming message from remote
      const incomingMessage = createTestMessage({
        id: 'remote-msg-1',
        content: 'Hello from remote!',
        sender: { id: 'user-2', name: 'Remote User', type: 'human' },
      })
      adapter.simulateIncomingMessage(incomingMessage)

      // Verify message received
      expect(receivedMessages).toHaveLength(1)
      expect(receivedMessages[0].id).toBe('remote-msg-1')
      expect(receivedMessages[0].content).toBe('Hello from remote!')

      // Verify message synced to replication state
      expect(replicationState.messages).toHaveLength(1)
      expect(replicationState.messages[0].id).toBe('remote-msg-1')
    })

    it('should handle multiple messages in sequence', async () => {
      const receivedMessages: Message[] = []
      adapter.on('message:received', (message: Message) => {
        receivedMessages.push(message)
        replicationState.pushHandler([message])
      })

      await adapter.connect({ userId: 'user-1', token: 'test-token' })

      // Simulate multiple incoming messages
      for (let i = 0; i < 5; i++) {
        const msg = createTestMessage({
          id: `msg-${i}`,
          content: `Message ${i}`,
        })
        adapter.simulateIncomingMessage(msg)
      }

      expect(receivedMessages).toHaveLength(5)
      expect(replicationState.messages).toHaveLength(5)

      // Verify order preserved
      replicationState.messages.forEach((msg, index) => {
        expect(msg.id).toBe(`msg-${index}`)
      })
    })

    it('should deduplicate messages by ID', async () => {
      adapter.on('message:received', (message: Message) => {
        replicationState.pushHandler([message])
      })

      await adapter.connect({ userId: 'user-1', token: 'test-token' })

      // Simulate same message received twice (common in real-time systems)
      const duplicateMessage = createTestMessage({ id: 'dup-msg-1' })
      adapter.simulateIncomingMessage(duplicateMessage)
      adapter.simulateIncomingMessage({ ...duplicateMessage, content: 'Updated content' })

      // Should have only one message, with updated content
      expect(replicationState.messages).toHaveLength(1)
      expect(replicationState.messages[0].content).toBe('Updated content')
    })
  })

  describe('Message Creation Flow', () => {
    it('should send message and receive confirmation', async () => {
      await adapter.connect({ userId: 'user-1', token: 'test-token' })

      // Send message via adapter
      const result = await adapter.sendMessage({
        conversationId: 'conv-1',
        content: 'Hello world!',
      })

      expect(result.messageId).toBeDefined()
      expect(result.message?.content).toBe('Hello world!')
      expect(result.message?.deliveryStatus).toBe('sent')
    })

    it('should track sent messages', async () => {
      await adapter.connect({ userId: 'user-1', token: 'test-token' })

      await adapter.sendMessage({
        conversationId: 'conv-1',
        content: 'First message',
      })
      await adapter.sendMessage({
        conversationId: 'conv-1',
        content: 'Second message',
      })

      expect(adapter.sendMessageCalls).toHaveLength(2)
      expect(adapter.sendMessageCalls[0].content).toBe('First message')
      expect(adapter.sendMessageCalls[1].content).toBe('Second message')
    })

    it('should send message with thread reply (parentId)', async () => {
      await adapter.connect({ userId: 'user-1', token: 'test-token' })

      const result = await adapter.sendMessage({
        conversationId: 'conv-1',
        content: 'Thread reply',
        parentId: 'parent-msg-1',
      })

      expect(result.message?.parentId).toBe('parent-msg-1')
      expect(adapter.sendMessageCalls[0].parentId).toBe('parent-msg-1')
    })
  })

  describe('Replication Pull Handler', () => {
    it('should fetch messages through pull handler', async () => {
      // Pre-populate replication state
      replicationState.messages.push(
        createTestMessage({ id: 'msg-1', content: 'First' }),
        createTestMessage({ id: 'msg-2', content: 'Second' }),
        createTestMessage({ id: 'msg-3', content: 'Third' })
      )

      // Pull from replication state
      const result = await replicationState.pullHandler(null, 10)

      expect(result.documents).toHaveLength(3)
      expect(result.checkpoint).toBeDefined()
    })

    it('should return empty array when no messages', async () => {
      const result = await replicationState.pullHandler(null, 10)

      expect(result.documents).toHaveLength(0)
      expect(result.checkpoint).toBeNull()
    })
  })

  describe('Typing Indicators Sync', () => {
    it('should emit typing events', async () => {
      const typingEvents: { conversationId: string; userId: string }[] = []

      adapter.on('typing:start', (event) => {
        typingEvents.push(event)
      })

      await adapter.connect({ userId: 'user-1', token: 'test-token' })

      // Simulate typing indicator from remote user
      adapter.simulateTypingStart('conv-1', 'user-2', 'Remote User')

      expect(typingEvents).toHaveLength(1)
      expect(typingEvents[0]).toEqual({
        conversationId: 'conv-1',
        userId: 'user-2',
        userName: 'Remote User',
      })
    })

    it('should track local typing calls', async () => {
      await adapter.connect({ userId: 'user-1', token: 'test-token' })

      await adapter.sendTyping('conv-1', true)
      await adapter.sendTyping('conv-1', false)

      expect(adapter.sendTypingCalls).toHaveLength(2)
      expect(adapter.sendTypingCalls[0]).toEqual({ conversationId: 'conv-1', isTyping: true })
      expect(adapter.sendTypingCalls[1]).toEqual({ conversationId: 'conv-1', isTyping: false })
    })

    it('should handle typing stop events', async () => {
      const typingStopEvents: { conversationId: string; userId: string }[] = []

      adapter.on('typing:stop', (event) => {
        typingStopEvents.push(event)
      })

      await adapter.connect({ userId: 'user-1', token: 'test-token' })
      adapter.simulateTypingStop('conv-1', 'user-2')

      expect(typingStopEvents).toHaveLength(1)
      expect(typingStopEvents[0]).toEqual({
        conversationId: 'conv-1',
        userId: 'user-2',
      })
    })
  })

  describe('Connection State Management', () => {
    it('should handle connection lifecycle', async () => {
      const statusChanges: string[] = []

      adapter.on('connection:status', (status) => {
        statusChanges.push(status)
      })

      // Connect
      await adapter.connect({ userId: 'user-1', token: 'test-token' })
      expect(adapter.status).toBe('connected')

      // Disconnect
      await adapter.disconnect()
      expect(adapter.status).toBe('disconnected')

      expect(statusChanges).toContain('connected')
      expect(statusChanges).toContain('disconnected')
    })

    it('should handle connection errors', async () => {
      adapter.shouldFailConnect = true

      const errors: Error[] = []
      adapter.on('connection:error', ({ error }) => {
        errors.push(error)
      })

      await expect(
        adapter.connect({ userId: 'user-1', token: 'test-token' })
      ).rejects.toThrow('Mock connection failed')

      expect(errors).toHaveLength(1)
      expect(adapter.status).toBe('error')
    })

    it('should handle connection lost', async () => {
      await adapter.connect({ userId: 'user-1', token: 'test-token' })

      const disconnectEvents: unknown[] = []
      adapter.on('connection:disconnected', (event) => {
        disconnectEvents.push(event)
      })

      adapter.simulateConnectionLost()

      expect(adapter.status).toBe('disconnected')
      expect(disconnectEvents).toHaveLength(1)
    })

    it('should queue messages during reconnection', async () => {
      // This simulates the scenario where:
      // 1. Connection is lost
      // 2. Local changes accumulate
      // 3. On reconnect, push handler flushes queued changes

      await adapter.connect({ userId: 'user-1', token: 'test-token' })

      // Simulate connection loss
      adapter.simulateConnectionLost()

      // Queue up local changes (simulating optimistic updates)
      const localChanges: Message[] = [
        createTestMessage({ id: 'local-1', content: 'Queued message 1' }),
        createTestMessage({ id: 'local-2', content: 'Queued message 2' }),
      ]

      // Reconnect
      adapter.shouldFailConnect = false
      await adapter.connect({ userId: 'user-1', token: 'test-token' })

      // Flush queued changes
      await replicationState.pushHandler(localChanges)

      expect(replicationState.messages).toHaveLength(2)
      expect(replicationState.messages.map((m) => m.id)).toEqual(['local-1', 'local-2'])
    })
  })

  describe('Fetch Operations', () => {
    it('should fetch messages from adapter', async () => {
      // Pre-populate adapter with messages
      for (let i = 0; i < 10; i++) {
        adapter.messages.push(createTestMessage({ id: `msg-${i}` }))
      }

      const result = await adapter.fetchMessages('conv-1', { limit: 5 })

      expect(result.messages).toHaveLength(5)
      expect(result.hasMore).toBe(true)
    })

    it('should fetch all messages when under limit', async () => {
      adapter.messages.push(
        createTestMessage({ id: 'msg-1' }),
        createTestMessage({ id: 'msg-2' })
      )

      const result = await adapter.fetchMessages('conv-1', { limit: 10 })

      expect(result.messages).toHaveLength(2)
      expect(result.hasMore).toBe(false)
    })

    it('should get user by ID', async () => {
      const user = await adapter.getUser('user-1')

      expect(user).toEqual({
        id: 'test-user',
        name: 'Test User',
        type: 'human',
      })
    })
  })

  describe('Presence Sync', () => {
    it('should set presence status', async () => {
      await adapter.connect({ userId: 'user-1', token: 'test-token' })

      await adapter.setPresence('online')
      await adapter.setPresence('away')
      await adapter.setPresence('offline')

      expect(adapter.presenceCalls).toEqual(['online', 'away', 'offline'])
    })
  })

  describe('Message Operations', () => {
    it('should subscribe to conversation', async () => {
      const unsubscribe = await adapter.subscribeToConversation('conv-1')

      expect(typeof unsubscribe).toBe('function')

      // Should not throw when calling unsubscribe
      unsubscribe()
    })

    it('should subscribe to presence', async () => {
      const unsubscribe = await adapter.subscribeToPresence(['user-1', 'user-2'])

      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })

    it('should handle message reactions', async () => {
      // These are no-ops in mock but should not throw
      await adapter.addReaction('msg-1', '👍')
      await adapter.removeReaction('msg-1', '👍')
    })

    it('should handle message editing', async () => {
      await adapter.editMessage('msg-1', 'Updated content')
      // No-op in mock but should not throw
    })

    it('should handle message deletion', async () => {
      await adapter.deleteMessage('msg-1')
      // No-op in mock but should not throw
    })

    it('should mark messages as read', async () => {
      await adapter.markAsRead('conv-1', 'msg-1')
      // No-op in mock but should not throw
    })
  })
})
