/**
 * RocketChat Adapter (stub)
 *
 * Placeholder for RocketChat integration.
 * App provides the actual DDP connection using existing code.
 */

import { BaseAdapter } from '../base'
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
} from '../../types'
import type { Message, Conversation, Participant, Unsubscribe } from '@mongrov/types'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RocketChatAdapterConfig {
  /** Server URL */
  serverUrl: string
  /**
   * Existing RocketChat client/connection.
   * App provides their existing DDP client instance.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client?: any
}

/**
 * RocketChat adapter stub.
 *
 * This is a placeholder that the app will extend or replace
 * with their existing RocketChat integration.
 *
 * @example
 * ```typescript
 * // App creates adapter wrapping their existing RC client
 * class MyRocketChatAdapter extends RocketChatAdapter {
 *   constructor(myExistingClient: MyRCClient) {
 *     super({ serverUrl: myExistingClient.url })
 *     this.rcClient = myExistingClient
 *   }
 *
 *   async connect(credentials) {
 *     await this.rcClient.connect(credentials)
 *     this.setStatus('connected')
 *   }
 *   // ... implement other methods using existing client
 * }
 * ```
 */
export class RocketChatAdapter extends BaseAdapter {
  readonly id = 'rocketchat'

  protected config: RocketChatAdapterConfig

  constructor(config: RocketChatAdapterConfig) {
    super()
    this.config = config
  }

  // ─── Connection (to be implemented by app) ──────────────────────────────

  async connect(_credentials: AdapterCredentials): Promise<void> {
    throw new Error('RocketChatAdapter.connect() must be implemented by subclass')
  }

  async disconnect(): Promise<void> {
    throw new Error('RocketChatAdapter.disconnect() must be implemented by subclass')
  }

  // ─── Messages ───────────────────────────────────────────────────────────

  async sendMessage(_params: SendMessageParams): Promise<SendMessageResult> {
    throw new Error('RocketChatAdapter.sendMessage() must be implemented by subclass')
  }

  async editMessage(_messageId: string, _newContent: string): Promise<void> {
    throw new Error('RocketChatAdapter.editMessage() must be implemented by subclass')
  }

  async deleteMessage(_messageId: string): Promise<void> {
    throw new Error('RocketChatAdapter.deleteMessage() must be implemented by subclass')
  }

  async fetchMessages(
    _conversationId: string,
    _options?: FetchMessagesOptions
  ): Promise<FetchMessagesResult> {
    throw new Error('RocketChatAdapter.fetchMessages() must be implemented by subclass')
  }

  // ─── Typing ─────────────────────────────────────────────────────────────

  async sendTyping(_conversationId: string, _isTyping: boolean): Promise<void> {
    throw new Error('RocketChatAdapter.sendTyping() must be implemented by subclass')
  }

  // ─── Presence ───────────────────────────────────────────────────────────

  async setPresence(_status: PresenceState): Promise<void> {
    throw new Error('RocketChatAdapter.setPresence() must be implemented by subclass')
  }

  // ─── Reactions ──────────────────────────────────────────────────────────

  async addReaction(_messageId: string, _emoji: string): Promise<void> {
    throw new Error('RocketChatAdapter.addReaction() must be implemented by subclass')
  }

  async removeReaction(_messageId: string, _emoji: string): Promise<void> {
    throw new Error('RocketChatAdapter.removeReaction() must be implemented by subclass')
  }

  // ─── Subscriptions ──────────────────────────────────────────────────────

  async subscribeToConversation(_conversationId: string): Promise<Unsubscribe> {
    throw new Error('RocketChatAdapter.subscribeToConversation() must be implemented by subclass')
  }

  async subscribeToPresence(_userIds: string[]): Promise<Unsubscribe> {
    throw new Error('RocketChatAdapter.subscribeToPresence() must be implemented by subclass')
  }

  // ─── Read Receipts ──────────────────────────────────────────────────────

  async markAsRead(_conversationId: string, _messageId?: string): Promise<void> {
    throw new Error('RocketChatAdapter.markAsRead() must be implemented by subclass')
  }

  // ─── Conversations ──────────────────────────────────────────────────────

  async fetchConversations(
    _options?: FetchConversationsOptions
  ): Promise<FetchConversationsResult> {
    throw new Error('RocketChatAdapter.fetchConversations() must be implemented by subclass')
  }

  // ─── Users ──────────────────────────────────────────────────────────────

  async getUser(_userId: string): Promise<Participant | null> {
    throw new Error('RocketChatAdapter.getUser() must be implemented by subclass')
  }

  // ─── Search ─────────────────────────────────────────────────────────────

  async searchMessages(_query: string, _options?: SearchOptions): Promise<Message[]> {
    throw new Error('RocketChatAdapter.searchMessages() must be implemented by subclass')
  }
}
