/**
 * XState v5 Connection Machine
 *
 * Manages connection states, reconnection with exponential backoff,
 * and coordination with the CollabAdapter.
 */

import { setup, assign, fromPromise } from 'xstate'
import type {
  CollabAdapter,
  AdapterCredentials,
  CollabConnectionStatus,
  CollabConfig,
  CollabLogger,
} from './types'

// ─── Context ────────────────────────────────────────────────────────────────

export interface CollabMachineContext {
  adapter: CollabAdapter
  credentials: AdapterCredentials | null
  error: Error | null
  reconnectAttempts: number
  maxReconnectAttempts: number
  baseDelay: number
  maxDelay: number
  logger: CollabLogger
}

// ─── Events ─────────────────────────────────────────────────────────────────

export type CollabMachineEvent =
  | { type: 'CONNECT'; credentials: AdapterCredentials }
  | { type: 'DISCONNECT' }
  | { type: 'CONNECTION_SUCCESS' }
  | { type: 'CONNECTION_ERROR'; error: Error }
  | { type: 'CONNECTION_LOST'; reason?: string }
  | { type: 'RETRY' }

// ─── Helpers ────────────────────────────────────────────────────────────────

const noopLogger: CollabLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

function calculateDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number
): number {
  // Exponential backoff with jitter
  const exponentialDelay = baseDelay * Math.pow(2, attempt)
  const jitter = Math.random() * 0.3 * exponentialDelay
  return Math.min(exponentialDelay + jitter, maxDelay)
}

// ─── Actors ─────────────────────────────────────────────────────────────────

const connectActor = fromPromise<void, { adapter: CollabAdapter; credentials: AdapterCredentials }>(
  async ({ input }) => {
    await input.adapter.connect(input.credentials)
  }
)

const disconnectActor = fromPromise<void, { adapter: CollabAdapter }>(
  async ({ input }) => {
    await input.adapter.disconnect()
  }
)

// ─── Machine ────────────────────────────────────────────────────────────────

export const collabMachine = setup({
  types: {
    context: {} as CollabMachineContext,
    events: {} as CollabMachineEvent,
    input: {} as CollabMachineInput,
  },
  actors: {
    connect: connectActor,
    disconnect: disconnectActor,
  },
  guards: {
    canRetry: ({ context }) => {
      return context.reconnectAttempts < context.maxReconnectAttempts
    },
    hasCredentials: ({ context }) => {
      return context.credentials !== null
    },
  },
  actions: {
    setCredentials: assign({
      credentials: ({ event }) => {
        if (event.type === 'CONNECT') {
          return event.credentials
        }
        return null
      },
    }),
    clearCredentials: assign({
      credentials: () => null,
    }),
    setError: assign({
      error: ({ event }) => {
        if (event.type === 'CONNECTION_ERROR') {
          return event.error
        }
        return null
      },
    }),
    clearError: assign({
      error: () => null,
    }),
    incrementReconnectAttempts: assign({
      reconnectAttempts: ({ context }) => context.reconnectAttempts + 1,
    }),
    resetReconnectAttempts: assign({
      reconnectAttempts: () => 0,
    }),
    logConnecting: ({ context }) => {
      context.logger.info('Connecting to server')
    },
    logConnected: ({ context }) => {
      context.logger.info('Connected to server')
    },
    logDisconnected: ({ context }) => {
      context.logger.info('Disconnected from server')
    },
    logReconnecting: ({ context }) => {
      context.logger.info('Reconnecting', {
        attempt: context.reconnectAttempts + 1,
        maxAttempts: context.maxReconnectAttempts,
      })
    },
    logError: ({ context, event }) => {
      if (event.type === 'CONNECTION_ERROR') {
        context.logger.error('Connection error', { error: event.error.message })
      }
    },
    logMaxRetriesReached: ({ context }) => {
      context.logger.error('Max reconnection attempts reached', {
        attempts: context.reconnectAttempts,
      })
    },
  },
  delays: {
    reconnectDelay: ({ context }) => {
      return calculateDelay(
        context.reconnectAttempts,
        context.baseDelay,
        context.maxDelay
      )
    },
  },
}).createMachine({
  id: 'collab',
  initial: 'disconnected',
  context: ({ input }) => ({
    adapter: input.adapter,
    credentials: null,
    error: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: input.maxReconnectAttempts ?? 10,
    baseDelay: input.baseDelay ?? 1000,
    maxDelay: input.maxDelay ?? 30000,
    logger: input.logger ?? noopLogger,
  }),
  states: {
    disconnected: {
      entry: ['clearError', 'resetReconnectAttempts'],
      on: {
        CONNECT: {
          target: 'connecting',
          actions: ['setCredentials', 'logConnecting'],
        },
      },
    },

    connecting: {
      invoke: {
        id: 'connect',
        src: 'connect',
        input: ({ context }) => ({
          adapter: context.adapter,
          credentials: context.credentials!,
        }),
        onDone: {
          target: 'connected',
          actions: ['clearError', 'resetReconnectAttempts', 'logConnected'],
        },
        onError: {
          target: 'error',
          actions: [
            assign({
              error: ({ event }) => event.error as Error,
            }),
            'logError',
          ],
        },
      },
      on: {
        DISCONNECT: {
          target: 'disconnecting',
        },
      },
    },

    connected: {
      on: {
        DISCONNECT: {
          target: 'disconnecting',
        },
        CONNECTION_LOST: {
          target: 'reconnecting',
          actions: ['logReconnecting'],
        },
        CONNECTION_ERROR: {
          target: 'reconnecting',
          actions: ['setError', 'logError', 'logReconnecting'],
        },
      },
    },

    reconnecting: {
      entry: ['incrementReconnectAttempts'],
      after: {
        reconnectDelay: [
          {
            target: 'connecting',
            guard: 'canRetry',
          },
          {
            target: 'error',
            actions: ['logMaxRetriesReached'],
          },
        ],
      },
      on: {
        DISCONNECT: {
          target: 'disconnecting',
        },
        RETRY: {
          target: 'connecting',
          guard: 'canRetry',
        },
      },
    },

    disconnecting: {
      invoke: {
        id: 'disconnect',
        src: 'disconnect',
        input: ({ context }) => ({
          adapter: context.adapter,
        }),
        onDone: {
          target: 'disconnected',
          actions: ['clearCredentials', 'logDisconnected'],
        },
        onError: {
          target: 'disconnected',
          actions: ['clearCredentials', 'logDisconnected'],
        },
      },
    },

    error: {
      on: {
        CONNECT: {
          target: 'connecting',
          actions: ['setCredentials', 'clearError', 'resetReconnectAttempts', 'logConnecting'],
        },
        DISCONNECT: {
          target: 'disconnected',
        },
        RETRY: {
          target: 'reconnecting',
          guard: 'hasCredentials',
        },
      },
    },
  },
})

// ─── Input Type ─────────────────────────────────────────────────────────────

export interface CollabMachineInput {
  adapter: CollabAdapter
  maxReconnectAttempts?: number
  baseDelay?: number
  maxDelay?: number
  logger?: CollabLogger
}

// ─── Helper Functions ───────────────────────────────────────────────────────

/**
 * Maps machine state to CollabConnectionStatus.
 */
export function getConnectionStatus(
  stateValue: string
): CollabConnectionStatus {
  const statusMap: Record<string, CollabConnectionStatus> = {
    disconnected: 'disconnected',
    connecting: 'connecting',
    connected: 'connected',
    reconnecting: 'reconnecting',
    disconnecting: 'disconnected',
    error: 'error',
  }
  return statusMap[stateValue] ?? 'disconnected'
}

/**
 * Creates machine input from CollabConfig.
 */
export function createMachineInput(config: CollabConfig): CollabMachineInput {
  return {
    adapter: config.adapter,
    maxReconnectAttempts: config.reconnect?.maxAttempts ?? 10,
    baseDelay: config.reconnect?.baseDelay ?? 1000,
    maxDelay: config.reconnect?.maxDelay ?? 30000,
    logger: config.logger ?? noopLogger,
  }
}
