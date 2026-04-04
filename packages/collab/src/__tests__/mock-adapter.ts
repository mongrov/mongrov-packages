/**
 * Mock Adapter for Testing
 */

import { BaseAdapter } from '../adapters/base'
import type {
  AdapterCredentials,
  SendMessageParams,
  SendMessageResult,
  PresenceState,
  FetchMessagesOptions,
  FetchMessagesResult,
  FetchConversationsOptions,
  FetchConversationsResult,
  SearchOptions,
} from '../types'
import type { Message, Participant, Unsubscribe } from '@mongrov/types'

export class MockAdapter extends BaseAdapter {
  readonly id = 'mock'

  // Track calls for testing
  connectCalls: AdapterCredentials[] = []
  disconnectCalls: number = 0
  sendMessageCalls: SendMessageParams[] = []
  sendTypingCalls: { conversationId: string; isTyping: boolean }[] = []
  presenceCalls: PresenceState[] = []

  // Control behavior
  shouldFailConnect = false
  connectDelay = 0
  messages: Message[] = []

  async connect(credentials: AdapterCredentials): Promise<void> {
    this.connectCalls.push(credentials)

    if (this.connectDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.connectDelay))
    }

    if (this.shouldFailConnect) {
      this.setStatus('error')
      const error = new Error('Mock connection failed')
      this.emit('connection:error', { error })
      throw error
    }

    this.setStatus('connected')
    this.emit('connection:connected', undefined)
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++
    this.setStatus('disconnected')
    this.emit('connection:disconnected', {})
  }

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    this.sendMessageCalls.push(params)

    const message: Message = {
      id: `msg-${Date.now()}`,
      conversationId: params.conversationId,
      sender: { id: 'test-user', name: 'Test User', type: 'human' },
      content: params.content,
      parentId: params.parentId,
      deliveryStatus: 'sent',
      createdAt: new Date().toISOString(),
    }

    this.messages.push(message)
    this.emit('message:received', message)

    return { messageId: message.id, message }
  }

  async sendTyping(conversationId: string, isTyping: boolean): Promise<void> {
    this.sendTypingCalls.push({ conversationId, isTyping })
  }

  async setPresence(status: PresenceState): Promise<void> {
    this.presenceCalls.push(status)
  }

  async addReaction(_messageId: string, _emoji: string): Promise<void> {
    // No-op for testing
  }

  async removeReaction(_messageId: string, _emoji: string): Promise<void> {
    // No-op for testing
  }

  async editMessage(_messageId: string, _newContent: string): Promise<void> {
    // No-op for testing
  }

  async deleteMessage(_messageId: string): Promise<void> {
    // No-op for testing
  }

  async markAsRead(_conversationId: string, _messageId?: string): Promise<void> {
    // No-op for testing
  }

  async subscribeToConversation(_conversationId: string): Promise<Unsubscribe> {
    return () => {}
  }

  async subscribeToPresence(_userIds: string[]): Promise<Unsubscribe> {
    return () => {}
  }

  async fetchMessages(
    _conversationId: string,
    options?: FetchMessagesOptions
  ): Promise<FetchMessagesResult> {
    const limit = options?.limit ?? 50
    return {
      messages: this.messages.slice(0, limit),
      hasMore: this.messages.length > limit,
    }
  }

  async fetchConversations(
    _options?: FetchConversationsOptions
  ): Promise<FetchConversationsResult> {
    return {
      conversations: [],
      hasMore: false,
    }
  }

  async getUser(_userId: string): Promise<Participant | null> {
    return { id: 'test-user', name: 'Test User', type: 'human' }
  }

  async searchMessages(_query: string, _options?: SearchOptions): Promise<Message[]> {
    return []
  }

  // Test helpers
  simulateConnectionLost(): void {
    this.setStatus('disconnected')
    this.emit('connection:disconnected', { reason: 'Connection lost' })
  }

  simulateError(error: Error): void {
    this.emit('connection:error', { error })
  }

  simulateIncomingMessage(message: Message): void {
    this.messages.push(message)
    this.emit('message:received', message)
  }

  simulateTypingStart(conversationId: string, userId: string, userName?: string): void {
    this.emit('typing:start', { conversationId, userId, userName })
  }

  simulateTypingStop(conversationId: string, userId: string): void {
    this.emit('typing:stop', { conversationId, userId })
  }

  reset(): void {
    this.connectCalls = []
    this.disconnectCalls = 0
    this.sendMessageCalls = []
    this.sendTypingCalls = []
    this.presenceCalls = []
    this.shouldFailConnect = false
    this.connectDelay = 0
    this.messages = []
    this.setStatus('disconnected')
  }
}
