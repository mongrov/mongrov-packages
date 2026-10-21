/**
 * XState v5 Connection Machine
 *
 * Manages connection states, reconnection with exponential backoff,
 * and coordination with the CollabAdapter.
 */

import type {
  AdapterCredentials,
  CollabAdapter,
  CollabConfig,
  CollabConnectionStatus,
  CollabLogger,
} from './types'
import { assign, fromPromise, setup } from 'xstate'
import { noopCollabLogger } from './logger'

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

export type CollabMachineEvent
  = | { type: 'CONNECT', credentials: AdapterCredentials }
    | { type: 'DISCONNECT' }
    | { type: 'CONNECTION_SUCCESS' }
    | { type: 'CONNECTION_ERROR', error: Error }
    | { type: 'CONNECTION_LOST', reason?: string }
    | { type: 'RETRY' }

// ─── Helpers ────────────────────────────────────────────────────────────────

const noopLogger: CollabLogger = noopCollabLogger

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function calculateDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
): number {
  // Exponential backoff with jitter
  const exponentialDelay = baseDelay * 2 ** attempt
  const jitter = Math.random() * 0.3 * exponentialDelay
  return Math.min(exponentialDelay + jitter, maxDelay)
}

// ─── Actors ─────────────────────────────────────────────────────────────────

const connectActor = fromPromise<void, { adapter: CollabAdapter, credentials: AdapterCredentials }>(
  async ({ input }) => {
    await input.adapter.connect(input.credentials)
  },
)

const disconnectActor = fromPromise<void, { adapter: CollabAdapter }>(
  async ({ input }) => {
    await input.adapter.disconnect()
  },
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
      context.logger.info('[Collab] connecting', { adapter: context.adapter.id })
    },
    logConnected: ({ context }) => {
      context.logger.info('[Collab] connected', {
        adapter: context.adapter.id,
        afterReconnectAttempts: context.reconnectAttempts,
      })
    },
    logDisconnected: ({ context }) => {
      context.logger.info('[Collab] disconnected', { adapter: context.adapter.id })
    },
    logDisconnectFailed: ({ context, event }) => {
      // Handled: the machine still lands in `disconnected`.
      context.logger.warn('[Collab] disconnect failed; treating as disconnected', {
        adapter: context.adapter.id,
        error: describeError((event as { error?: unknown }).error),
      })
    },
    logConnectionLost: ({ context, event }) => {
      context.logger.warn('[Collab] connection lost', {
        adapter: context.adapter.id,
        reason: event.type === 'CONNECTION_LOST' ? event.reason : undefined,
      })
    },
    logReconnecting: ({ context }) => {
      context.logger.info('[Collab] reconnecting', {
        attempt: context.reconnectAttempts + 1,
        maxAttempts: context.maxReconnectAttempts,
      })
    },
    logRetryRequested: ({ context }) => {
      context.logger.info('[Collab] retry requested', { adapter: context.adapter.id })
    },
    // A connection that was up reported an error: the machine reconnects, so
    // this is degraded, not terminal.
    logConnectionError: ({ context, event }) => {
      if (event.type === 'CONNECTION_ERROR') {
        context.logger.warn('[Collab] connection error', {
          adapter: context.adapter.id,
          error: describeError(event.error),
        })
      }
    },
    // `connect()` rejected: the machine stops in `error` until CONNECT/RETRY.
    // Reads `context.error` (assigned just before) because the invoke's error
    // event is not a CONNECTION_ERROR.
    logConnectFailed: ({ context }) => {
      context.logger.error('[Collab] connect failed', {
        adapter: context.adapter.id,
        reconnectAttempts: context.reconnectAttempts,
        error: describeError(context.error),
      })
    },
    logMaxRetriesReached: ({ context }) => {
      context.logger.error('[Collab] max reconnection attempts reached', {
        attempts: context.reconnectAttempts,
      })
    },
  },
  delays: {
    reconnectDelay: ({ context }) => {
      return calculateDelay(
        context.reconnectAttempts,
        context.baseDelay,
        context.maxDelay,
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
          // Log first so the line carries how many attempts it took.
          actions: ['logConnected', 'clearError', 'resetReconnectAttempts'],
        },
        onError: {
          target: 'error',
          actions: [
            assign({
              error: ({ event }) => event.error as Error,
            }),
            'logConnectFailed',
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
          actions: ['logConnectionLost', 'logReconnecting'],
        },
        CONNECTION_ERROR: {
          target: 'reconnecting',
          actions: ['setError', 'logConnectionError', 'logReconnecting'],
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
          actions: ['logRetryRequested'],
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
          actions: ['clearCredentials', 'logDisconnectFailed'],
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
          actions: ['logRetryRequested', 'logReconnecting'],
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
  stateValue: string,
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
