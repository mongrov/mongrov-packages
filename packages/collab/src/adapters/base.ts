/**
 * Base Adapter
 *
 * Provides common functionality for all adapters (event handling).
 */

import type {
  CollabAdapter,
  CollabConnectionStatus,
  CollabEventName,
  CollabEventHandler,
  CollabEvents,
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

/**
 * Abstract base class for collaboration adapters.
 *
 * Extend this class to implement a custom adapter for your backend.
 * The base class provides:
 * - Event subscription and emission (`on`, `emit`)
 * - Connection status tracking (`status`, `setStatus`)
 *
 * @example
 * ```typescript
 * import { BaseAdapter } from '@mongrov/collab'
 * import type { AdapterCredentials, SendMessageParams } from '@mongrov/collab'
 *
 * class MyWebSocketAdapter extends BaseAdapter {
 *   readonly id = 'my-websocket'
 *   private socket: WebSocket | null = null
 *
 *   async connect(credentials: AdapterCredentials) {
 *     this.socket = new WebSocket(credentials.serverUrl)
 *
 *     this.socket.onopen = () => {
 *       this.setStatus('connected')
 *       this.emit('connection:connected', undefined)
 *     }
 *
 *     this.socket.onmessage = (event) => {
 *       const data = JSON.parse(event.data)
 *       if (data.type === 'message') {
 *         this.emit('message:received', data.message)
 *       }
 *     }
 *
 *     this.socket.onerror = (error) => {
 *       this.setStatus('error')
 *       this.emit('connection:error', { error: new Error('WebSocket error') })
 *     }
 *   }
 *
 *   async disconnect() {
 *     this.socket?.close()
 *     this.setStatus('disconnected')
 *     this.emit('connection:disconnected', {})
 *   }
 *
 *   async sendMessage(params: SendMessageParams) {
 *     // Send via WebSocket and return result
 *     // ...
 *   }
 *
 *   // Implement other abstract methods...
 * }
 * ```
 */
export abstract class BaseAdapter implements CollabAdapter {
  /** Unique identifier for this adapter (e.g., 'rocketchat', 'custom-ws') */
  abstract readonly id: string

  /** Internal connection status */
  protected _status: CollabConnectionStatus = 'disconnected'

  private eventHandlers = new Map<CollabEventName, Set<CollabEventHandler<CollabEventName>>>()

  /** Current connection status */
  get status(): CollabConnectionStatus {
    return this._status
  }

  /**
   * Update the connection status and emit status change event.
   * Call this from your adapter implementation when status changes.
   *
   * @param status - New connection status
   */
  protected setStatus(status: CollabConnectionStatus): void {
    if (this._status !== status) {
      this._status = status
      this.emit('connection:status', status)
    }
  }

  // ─── Event Handling ─────────────────────────────────────────────────────

  /**
   * Subscribe to adapter events.
   *
   * @param event - Event name to subscribe to
   * @param handler - Function to call when event is emitted
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * const unsubscribe = adapter.on('message:received', (message) => {
   *   console.log('New message:', message.content)
   * })
   *
   * // Later, to stop listening:
   * unsubscribe()
   * ```
   */
  on<T extends CollabEventName>(
    event: T,
    handler: CollabEventHandler<T>
  ): Unsubscribe {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set())
    }
    this.eventHandlers.get(event)!.add(handler as CollabEventHandler<CollabEventName>)

    return () => {
      this.eventHandlers.get(event)?.delete(handler as CollabEventHandler<CollabEventName>)
    }
  }

  /**
   * Emit an event to all subscribers.
   * Call this from your adapter implementation to notify listeners.
   *
   * @param event - Event name to emit
   * @param payload - Event payload (type depends on event)
   *
   * @example
   * ```typescript
   * // In your adapter implementation:
   * this.emit('message:received', {
   *   id: 'msg-1',
   *   conversationId: 'conv-1',
   *   sender: { id: 'user-1', name: 'User', type: 'human' },
   *   content: { type: 'text', text: 'Hello!' },
   *   deliveryStatus: 'sent',
   *   createdAt: new Date().toISOString(),
   * })
   * ```
   */
  emit<T extends CollabEventName>(event: T, payload: CollabEvents[T]): void {
    const handlers = this.eventHandlers.get(event)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(payload)
        } catch (error) {
          console.error(`Error in event handler for ${event}:`, error)
        }
      }
    }
  }

  // ─── Abstract Methods ───────────────────────────────────────────────────

  abstract connect(credentials: AdapterCredentials): Promise<void>
  abstract disconnect(): Promise<void>
  abstract sendMessage(params: SendMessageParams): Promise<SendMessageResult>
  abstract sendTyping(conversationId: string, isTyping: boolean): Promise<void>
  abstract setPresence(status: PresenceState): Promise<void>
  abstract subscribeToConversation(conversationId: string): Promise<Unsubscribe>
  abstract subscribeToPresence(userIds: string[]): Promise<Unsubscribe>
  abstract addReaction(messageId: string, emoji: string): Promise<void>
  abstract removeReaction(messageId: string, emoji: string): Promise<void>
  abstract editMessage(messageId: string, newContent: string): Promise<void>
  abstract deleteMessage(messageId: string): Promise<void>
  abstract markAsRead(conversationId: string, messageId?: string): Promise<void>
  abstract fetchMessages(
    conversationId: string,
    options?: FetchMessagesOptions
  ): Promise<FetchMessagesResult>
  abstract fetchConversations(
    options?: FetchConversationsOptions
  ): Promise<FetchConversationsResult>
  abstract getUser(userId: string): Promise<Participant | null>
  abstract searchMessages(query: string, options?: SearchOptions): Promise<Message[]>
}
