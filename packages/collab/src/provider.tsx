/**
 * CollabProvider - React context provider for collaboration
 *
 * Manages connection state machine and provides hooks for components.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useCallback,
  useState,
  useRef,
  type ReactNode,
} from 'react'
import { createActor } from 'xstate'
import { useSelector } from '@xstate/react'

import {
  collabMachine,
  getConnectionStatus,
  createMachineInput,
  type CollabMachineEvent,
} from './machine'
import type {
  CollabConfig,
  CollabAdapter,
  CollabConnectionStatus,
  AdapterCredentials,
  SendMessageParams,
  SendMessageResult,
  PresenceState,
  UserPresence,
  TypingUser,
  CollabEventName,
  CollabEventHandler,
} from './types'
import type { Message, Unsubscribe } from '@mongrov/types'

// ─── Context ────────────────────────────────────────────────────────────────

interface CollabContextValue {
  /** Current connection status */
  status: CollabConnectionStatus
  /** Whether connected */
  isConnected: boolean
  /** Whether connecting or reconnecting */
  isConnecting: boolean
  /** Last error */
  error: Error | null
  /** Connect to server */
  connect: (credentials: AdapterCredentials) => void
  /** Disconnect from server */
  disconnect: () => void
  /** Retry connection */
  retry: () => void
  /** Send a message */
  sendMessage: (params: SendMessageParams) => Promise<SendMessageResult>
  /** Send typing indicator */
  sendTyping: (conversationId: string, isTyping: boolean) => Promise<void>
  /** Set presence status */
  setPresence: (status: PresenceState) => Promise<void>
  /** Add reaction to message */
  addReaction: (messageId: string, emoji: string) => Promise<void>
  /** Remove reaction from message */
  removeReaction: (messageId: string, emoji: string) => Promise<void>
  /** Edit a message */
  editMessage: (messageId: string, newContent: string) => Promise<void>
  /** Delete a message */
  deleteMessage: (messageId: string) => Promise<void>
  /** Mark messages as read */
  markAsRead: (conversationId: string, messageId?: string) => Promise<void>
  /** Subscribe to adapter events */
  on: <T extends CollabEventName>(
    event: T,
    handler: CollabEventHandler<T>
  ) => Unsubscribe
  /** The underlying adapter */
  adapter: CollabAdapter
}

const CollabContext = createContext<CollabContextValue | null>(null)

// ─── Provider ───────────────────────────────────────────────────────────────

export interface CollabProviderProps {
  /** Collab configuration */
  config: CollabConfig
  /** Child components */
  children: ReactNode
}

/**
 * Provides collaboration context to child components.
 *
 * @example
 * ```tsx
 * const adapter = createRocketChatAdapter({ serverUrl: 'wss://chat.example.com' })
 *
 * function App() {
 *   return (
 *     <CollabProvider config={{ adapter, autoConnect: false }}>
 *       <ChatApp />
 *     </CollabProvider>
 *   )
 * }
 * ```
 */
export function CollabProvider({ config, children }: CollabProviderProps): ReactNode {
  const { adapter, autoConnect = false } = config

  // Create the state machine actor
  const actorRef = useMemo(() => {
    const input = createMachineInput(config)
    return createActor(collabMachine, { input })
  }, [config])

  // Start the actor on mount
  useEffect(() => {
    actorRef.start()
    return () => {
      actorRef.stop()
    }
  }, [actorRef])

  // Get state from machine
  const stateValue = useSelector(actorRef, (state) => state.value as string)
  const error = useSelector(actorRef, (state) => state.context.error)

  const status = useMemo(() => getConnectionStatus(stateValue), [stateValue])
  const isConnected = status === 'connected'
  const isConnecting = status === 'connecting' || status === 'reconnecting'

  // Connection actions
  const connect = useCallback(
    (credentials: AdapterCredentials) => {
      actorRef.send({ type: 'CONNECT', credentials })
    },
    [actorRef]
  )

  const disconnect = useCallback(() => {
    actorRef.send({ type: 'DISCONNECT' })
  }, [actorRef])

  const retry = useCallback(() => {
    actorRef.send({ type: 'RETRY' })
  }, [actorRef])

  // Wire up adapter events to machine
  useEffect(() => {
    const unsubConnected = adapter.on('connection:connected', () => {
      actorRef.send({ type: 'CONNECTION_SUCCESS' })
    })

    const unsubDisconnected = adapter.on('connection:disconnected', ({ reason }) => {
      actorRef.send({ type: 'CONNECTION_LOST', reason })
    })

    const unsubError = adapter.on('connection:error', ({ error: err }) => {
      actorRef.send({ type: 'CONNECTION_ERROR', error: err })
    })

    return () => {
      unsubConnected()
      unsubDisconnected()
      unsubError()
    }
  }, [adapter, actorRef])

  // Adapter method wrappers
  const sendMessage = useCallback(
    (params: SendMessageParams) => adapter.sendMessage(params),
    [adapter]
  )

  const sendTyping = useCallback(
    (conversationId: string, isTyping: boolean) =>
      adapter.sendTyping(conversationId, isTyping),
    [adapter]
  )

  const setPresence = useCallback(
    (presenceStatus: PresenceState) => adapter.setPresence(presenceStatus),
    [adapter]
  )

  const addReaction = useCallback(
    (messageId: string, emoji: string) => adapter.addReaction(messageId, emoji),
    [adapter]
  )

  const removeReaction = useCallback(
    (messageId: string, emoji: string) => adapter.removeReaction(messageId, emoji),
    [adapter]
  )

  const editMessage = useCallback(
    (messageId: string, newContent: string) =>
      adapter.editMessage(messageId, newContent),
    [adapter]
  )

  const deleteMessage = useCallback(
    (messageId: string) => adapter.deleteMessage(messageId),
    [adapter]
  )

  const markAsRead = useCallback(
    (conversationId: string, messageId?: string) =>
      adapter.markAsRead(conversationId, messageId),
    [adapter]
  )

  const on = useCallback(
    <T extends CollabEventName>(event: T, handler: CollabEventHandler<T>) =>
      adapter.on(event, handler),
    [adapter]
  )

  const value = useMemo<CollabContextValue>(
    () => ({
      status,
      isConnected,
      isConnecting,
      error,
      connect,
      disconnect,
      retry,
      sendMessage,
      sendTyping,
      setPresence,
      addReaction,
      removeReaction,
      editMessage,
      deleteMessage,
      markAsRead,
      on,
      adapter,
    }),
    [
      status,
      isConnected,
      isConnecting,
      error,
      connect,
      disconnect,
      retry,
      sendMessage,
      sendTyping,
      setPresence,
      addReaction,
      removeReaction,
      editMessage,
      deleteMessage,
      markAsRead,
      on,
      adapter,
    ]
  )

  return <CollabContext.Provider value={value}>{children}</CollabContext.Provider>
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

/**
 * Hook to access the collab context.
 * Must be used within CollabProvider.
 */
export function useCollab(): CollabContextValue {
  const context = useContext(CollabContext)
  if (!context) {
    throw new Error(
      '[useCollab] Hook called outside of CollabProvider.\n\n' +
      'To fix this, wrap your component tree with CollabProvider:\n\n' +
      '  import { CollabProvider } from "@mongrov/collab"\n\n' +
      '  function App() {\n' +
      '    return (\n' +
      '      <CollabProvider config={{ adapter }}>\n' +
      '        <YourComponent />\n' +
      '      </CollabProvider>\n' +
      '    )\n' +
      '  }'
    )
  }
  return context
}

/**
 * Hook for presence tracking.
 * Subscribes to presence updates for specified users.
 */
export function usePresence(userIds: string[]): {
  presence: Map<string, UserPresence>
  isLoading: boolean
} {
  const { adapter, isConnected } = useCollab()
  const [presence, setPresence] = useState<Map<string, UserPresence>>(new Map())
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (!isConnected || userIds.length === 0) {
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    let unsubscribe: Unsubscribe | null = null

    const setup = async () => {
      // Subscribe to presence updates
      unsubscribe = await adapter.subscribeToPresence(userIds)

      // Listen for presence changes
      const unsubPresence = adapter.on('presence:changed', ({ userId, status }) => {
        setPresence((prev) => {
          const next = new Map(prev)
          const existing = next.get(userId)
          next.set(userId, {
            userId,
            userName: existing?.userName,
            status,
            lastSeen: status === 'offline' ? new Date().toISOString() : undefined,
          })
          return next
        })
      })

      setIsLoading(false)

      return () => {
        unsubPresence()
      }
    }

    let cleanupPresence: (() => void) | undefined
    setup().then((cleanup) => {
      cleanupPresence = cleanup
    })

    return () => {
      unsubscribe?.()
      cleanupPresence?.()
    }
  }, [adapter, isConnected, userIds.join(',')])

  return { presence, isLoading }
}

/**
 * Hook for typing indicators in a conversation.
 */
export function useTyping(conversationId: string): {
  typingUsers: TypingUser[]
  sendTyping: (isTyping: boolean) => void
} {
  const { adapter, isConnected, sendTyping: sendTypingToServer } = useCollab()
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([])
  const typingTimeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map())

  // Listen for typing events
  useEffect(() => {
    if (!isConnected) return

    const unsubStart = adapter.on('typing:start', ({ conversationId: cid, userId, userName }) => {
      if (cid !== conversationId) return

      setTypingUsers((prev) => {
        // Remove existing entry for this user
        const filtered = prev.filter((u) => u.userId !== userId)
        return [...filtered, { userId, userName, startedAt: Date.now() }]
      })

      // Clear existing timeout
      const existing = typingTimeoutsRef.current.get(userId)
      if (existing) clearTimeout(existing)

      // Set timeout to remove typing after 5s of no updates
      const timeout = setTimeout(() => {
        setTypingUsers((prev) => prev.filter((u) => u.userId !== userId))
        typingTimeoutsRef.current.delete(userId)
      }, 5000)
      typingTimeoutsRef.current.set(userId, timeout)
    })

    const unsubStop = adapter.on('typing:stop', ({ conversationId: cid, userId }) => {
      if (cid !== conversationId) return

      setTypingUsers((prev) => prev.filter((u) => u.userId !== userId))
      const timeout = typingTimeoutsRef.current.get(userId)
      if (timeout) {
        clearTimeout(timeout)
        typingTimeoutsRef.current.delete(userId)
      }
    })

    return () => {
      unsubStart()
      unsubStop()
      // Clear all timeouts
      for (const timeout of typingTimeoutsRef.current.values()) {
        clearTimeout(timeout)
      }
      typingTimeoutsRef.current.clear()
    }
  }, [adapter, isConnected, conversationId])

  const sendTyping = useCallback(
    (isTyping: boolean) => {
      if (isConnected) {
        sendTypingToServer(conversationId, isTyping)
      }
    },
    [isConnected, conversationId, sendTypingToServer]
  )

  return { typingUsers, sendTyping }
}

/**
 * Hook for real-time messages in a conversation.
 * Handles optimistic updates and reconciliation.
 */
export function useMessages(conversationId: string): {
  messages: Message[]
  isLoading: boolean
  error: Error | null
  hasMore: boolean
  loadMore: () => Promise<void>
  refresh: () => Promise<void>
} {
  const { adapter, isConnected } = useCollab()
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const unsubscribeRef = useRef<Unsubscribe | null>(null)

  // Initial load and subscription
  useEffect(() => {
    if (!isConnected || !conversationId) {
      setIsLoading(false)
      return
    }

    const setup = async () => {
      setIsLoading(true)
      setError(null)

      try {
        // Fetch initial messages
        const result = await adapter.fetchMessages(conversationId, { limit: 50 })
        setMessages(result.messages)
        setHasMore(result.hasMore)

        // Subscribe to real-time updates
        unsubscribeRef.current = await adapter.subscribeToConversation(conversationId)

        // Listen for new messages
        const unsubReceived = adapter.on('message:received', (message) => {
          if (message.conversationId === conversationId) {
            setMessages((prev) => {
              // Check if message already exists (dedup)
              if (prev.some((m) => m.id === message.id)) return prev
              return [...prev, message]
            })
          }
        })

        // Listen for updated messages
        const unsubUpdated = adapter.on('message:updated', (message) => {
          if (message.conversationId === conversationId) {
            setMessages((prev) =>
              prev.map((m) => (m.id === message.id ? message : m))
            )
          }
        })

        // Listen for deleted messages
        const unsubDeleted = adapter.on('message:deleted', ({ messageId, conversationId: cid }) => {
          if (cid === conversationId) {
            setMessages((prev) => prev.filter((m) => m.id !== messageId))
          }
        })

        setIsLoading(false)

        return () => {
          unsubReceived()
          unsubUpdated()
          unsubDeleted()
        }
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)))
        setIsLoading(false)
      }
    }

    let cleanup: (() => void) | undefined
    setup().then((c) => {
      cleanup = c
    })

    return () => {
      cleanup?.()
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
    }
  }, [adapter, isConnected, conversationId])

  const loadMore = useCallback(async () => {
    if (!hasMore || isLoading || messages.length === 0) return

    try {
      const oldestMessage = messages[0]
      const result = await adapter.fetchMessages(conversationId, {
        before: oldestMessage.id,
        limit: 50,
      })
      setMessages((prev) => [...result.messages, ...prev])
      setHasMore(result.hasMore)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    }
  }, [adapter, conversationId, hasMore, isLoading, messages])

  const refresh = useCallback(async () => {
    if (!isConnected) return

    setIsLoading(true)
    try {
      const result = await adapter.fetchMessages(conversationId, { limit: 50 })
      setMessages(result.messages)
      setHasMore(result.hasMore)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoading(false)
    }
  }, [adapter, conversationId, isConnected])

  return { messages, isLoading, error, hasMore, loadMore, refresh }
}
