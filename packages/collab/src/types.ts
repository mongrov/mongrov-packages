/**
 * Core types for @mongrov/collab
 */

import type {
  Message,
  Conversation,
  Participant,
  Unsubscribe,
} from '@mongrov/types'

// ─── Connection Status ──────────────────────────────────────────────────────

export type CollabConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'

// ─── Events ─────────────────────────────────────────────────────────────────

export interface CollabEvents {
  /** Emitted when connection status changes */
  'connection:status': CollabConnectionStatus
  /** Emitted when connected successfully */
  'connection:connected': void
  /** Emitted when disconnected */
  'connection:disconnected': { reason?: string }
  /** Emitted on connection error */
  'connection:error': { error: Error }

  /** Emitted when a new message is received */
  'message:received': Message
  /** Emitted when a message is updated (edit, reactions) */
  'message:updated': Message
  /** Emitted when a message is deleted */
  'message:deleted': { messageId: string; conversationId: string }

  /** Emitted when user starts typing */
  'typing:start': { conversationId: string; userId: string; userName?: string }
  /** Emitted when user stops typing */
  'typing:stop': { conversationId: string; userId: string }

  /** Emitted when user presence changes */
  'presence:changed': { userId: string; status: PresenceState }
  /** Emitted when user goes online */
  'presence:online': { userId: string }
  /** Emitted when user goes offline */
  'presence:offline': { userId: string }

  /** Emitted when conversation is updated */
  'conversation:updated': Conversation
  /** Emitted when added to a conversation */
  'conversation:joined': Conversation
  /** Emitted when removed from a conversation */
  'conversation:left': { conversationId: string }
}

export type CollabEventName = keyof CollabEvents

export type CollabEventHandler<T extends CollabEventName> = (
  payload: CollabEvents[T]
) => void

// ─── Presence ───────────────────────────────────────────────────────────────

export type PresenceState = 'online' | 'away' | 'busy' | 'offline'

export interface UserPresence {
  userId: string
  userName?: string
  status: PresenceState
  lastSeen?: string // ISO 8601
}

// ─── Typing ─────────────────────────────────────────────────────────────────

export interface TypingUser {
  userId: string
  userName?: string
  startedAt: number // timestamp
}

// ─── Send Message ───────────────────────────────────────────────────────────

export interface SendMessageParams {
  conversationId: string
  content: {
    type: 'text' | 'image' | 'audio' | 'video' | 'file'
    text?: string
    uri?: string
    mimeType?: string
    fileName?: string
  }
  parentId?: string // for replies
  mentions?: string[] // user IDs
  metadata?: Record<string, unknown>
}

export interface SendMessageResult {
  messageId: string
  message: Message
}

// ─── Adapter Interface ──────────────────────────────────────────────────────

/**
 * CollabAdapter defines the interface that all collaboration backends must implement.
 * This enables swapping between RocketChat, custom WebSocket servers, or other backends.
 */
export interface CollabAdapter {
  /** Unique identifier for this adapter */
  readonly id: string

  /** Current connection status */
  readonly status: CollabConnectionStatus

  /**
   * Connect to the backend.
   * @param credentials - Authentication credentials
   */
  connect(credentials: AdapterCredentials): Promise<void>

  /**
   * Disconnect from the backend.
   */
  disconnect(): Promise<void>

  /**
   * Send a message to a conversation.
   */
  sendMessage(params: SendMessageParams): Promise<SendMessageResult>

  /**
   * Send typing indicator.
   */
  sendTyping(conversationId: string, isTyping: boolean): Promise<void>

  /**
   * Update user presence status.
   */
  setPresence(status: PresenceState): Promise<void>

  /**
   * Subscribe to a conversation for real-time updates.
   * Returns unsubscribe function.
   */
  subscribeToConversation(conversationId: string): Promise<Unsubscribe>

  /**
   * Subscribe to user presence updates.
   * Returns unsubscribe function.
   */
  subscribeToPresence(userIds: string[]): Promise<Unsubscribe>

  /**
   * Add reaction to a message.
   */
  addReaction(messageId: string, emoji: string): Promise<void>

  /**
   * Remove reaction from a message.
   */
  removeReaction(messageId: string, emoji: string): Promise<void>

  /**
   * Edit a message.
   */
  editMessage(messageId: string, newContent: string): Promise<void>

  /**
   * Delete a message.
   */
  deleteMessage(messageId: string): Promise<void>

  /**
   * Mark messages as read.
   */
  markAsRead(conversationId: string, messageId?: string): Promise<void>

  /**
   * Fetch message history.
   */
  fetchMessages(
    conversationId: string,
    options?: FetchMessagesOptions
  ): Promise<FetchMessagesResult>

  /**
   * Fetch conversation list.
   */
  fetchConversations(options?: FetchConversationsOptions): Promise<FetchConversationsResult>

  /**
   * Get user info.
   */
  getUser(userId: string): Promise<Participant | null>

  /**
   * Search messages.
   */
  searchMessages(query: string, options?: SearchOptions): Promise<Message[]>

  /**
   * Subscribe to adapter events.
   */
  on<T extends CollabEventName>(
    event: T,
    handler: CollabEventHandler<T>
  ): Unsubscribe

  /**
   * Emit an event (for internal use).
   */
  emit<T extends CollabEventName>(event: T, payload: CollabEvents[T]): void
}

// ─── Adapter Credentials ────────────────────────────────────────────────────

export interface AdapterCredentials {
  /** Server URL */
  serverUrl: string
  /** Authentication token */
  token?: string
  /** User ID (if known) */
  userId?: string
  /** Additional credentials (adapter-specific) */
  [key: string]: unknown
}

// ─── Fetch Options ──────────────────────────────────────────────────────────

export interface FetchMessagesOptions {
  /** Number of messages to fetch */
  limit?: number
  /** Fetch messages before this message ID */
  before?: string
  /** Fetch messages after this message ID */
  after?: string
}

export interface FetchMessagesResult {
  messages: Message[]
  hasMore: boolean
}

export interface FetchConversationsOptions {
  /** Number of conversations to fetch */
  limit?: number
  /** Pagination offset */
  offset?: number
  /** Filter by type */
  type?: 'direct' | 'group' | 'channel'
}

export interface FetchConversationsResult {
  conversations: Conversation[]
  hasMore: boolean
  total?: number
}

export interface SearchOptions {
  /** Limit results */
  limit?: number
  /** Search in specific conversation */
  conversationId?: string
}

// ─── Config ─────────────────────────────────────────────────────────────────

export interface CollabConfig {
  /** The adapter to use */
  adapter: CollabAdapter

  /** Auto-connect on mount */
  autoConnect?: boolean

  /** Reconnection settings */
  reconnect?: {
    /** Enable auto-reconnect @default true */
    enabled?: boolean
    /** Maximum reconnection attempts @default 10 */
    maxAttempts?: number
    /** Base delay in ms @default 1000 */
    baseDelay?: number
    /** Maximum delay in ms @default 30000 */
    maxDelay?: number
  }

  /** Typing indicator settings */
  typing?: {
    /** Debounce delay in ms @default 300 */
    debounceMs?: number
    /** Auto-stop typing after ms @default 5000 */
    timeoutMs?: number
  }

  /** Logger for debugging */
  logger?: CollabLogger
}

export interface CollabLogger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}
