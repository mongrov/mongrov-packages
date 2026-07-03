/**
 * connection-machine — per-device XState v5 actor.
 *
 * Encodes the state chart defined in device-spec §6.1:
 *   idle · scanning · connecting · discovering · enabling · cancelling ·
 *   connected · reconnecting · suspended · failed
 *
 * Locked rules:
 *   - cancel (in-progress) ≠ disconnect (established)
 *   - EMPTY scan resolves to `idle`, not `failed`
 *   - `ownership.reconnect === true`  → thin reflector (SDK drives reconnect;
 *                                        no `after`, no attempts counter)
 *   - `ownership.reconnect === false` → full driver (exponential backoff,
 *                                        8 attempt cap)
 *   - Global interrupts (BT_OFF / PERMISSION_REVOKED / BACKGROUNDED) →
 *     suspended (capturing priorPhase for RESUMED re-entry)
 *   - `rssi` and `elapsedMs` are CONTEXT, never states
 *
 * Zero React, zero db, zero vendor SDK; the machine takes a `DeviceAdapter`
 * only for its `ownership` shape (guards read the flag).
 */

import { setup, assign } from 'xstate'

import type {
  DeviceAdapter,
  ErrorDetail,
  ScanCandidate,
} from '../types'

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * Phase captured on entry to `suspended` so `RESUMED` can re-enter the
 * correct region rather than blindly returning to `idle`.
 */
export type ActivePhase =
  | 'scanning'
  | 'connecting'
  | 'discovering'
  | 'enabling'
  | 'connected'
  | 'reconnecting'

export interface ConnectionContext {
  deviceId: string
  adapter: DeviceAdapter
  candidate: ScanCandidate | undefined
  rssi: number | undefined
  elapsedMs: number | undefined
  lastError: ErrorDetail | undefined
  /** Full-driver reconnect attempts (thin reflector never touches this). */
  attemptsCount: number
  /** Phase captured on entry to `suspended`; consumed by `RESUMED`. */
  priorPhase: ActivePhase | undefined
}

export interface ConnectionInput {
  deviceId: string
  adapter: DeviceAdapter
  candidate?: ScanCandidate
}

export type ConnectionEvent =
  // Discovery / connect
  | { type: 'SCAN_START' }
  | { type: 'SCAN_FOUND'; candidate: ScanCandidate }
  | { type: 'SCAN_COMPLETE' }
  | { type: 'CONNECT'; candidate?: ScanCandidate }
  | { type: 'CONNECT_SUCCESS' }
  | { type: 'CONNECT_FAILURE'; detail: ErrorDetail }
  // Teardown
  | { type: 'DISCONNECT' } // user, from READY region
  | { type: 'UNEXPECTED_DISCONNECT'; detail?: ErrorDetail }
  | { type: 'CANCEL' } // in-progress cancel, ACTIVE region
  // Global (parent-forwarded)
  | { type: 'BT_OFF' }
  | { type: 'PERMISSION_REVOKED' }
  | { type: 'BACKGROUNDED' }
  | { type: 'RESUMED' }
  // Adapter telemetry (context-only)
  | { type: 'RSSI'; rssi: number }

export interface ConnectionDelays {
  scanTimeoutMs: number
  connectTimeoutMs: number
  discoverTimeoutMs: number
  enableTimeoutMs: number
  cancelFallbackMs: number
  /** Reconnect backoff cap (full-driver mode). */
  backoffCapMs: number
}

/** Design.md §6.1 typical values; overridable per-actor for tests. */
export const DEFAULT_DELAYS: ConnectionDelays = {
  scanTimeoutMs: 30_000,
  connectTimeoutMs: 15_000,
  discoverTimeoutMs: 10_000,
  enableTimeoutMs: 5_000,
  cancelFallbackMs: 5_000,
  backoffCapMs: 30_000,
}

/** Hard cap on full-driver reconnect attempts before giving up. */
export const MAX_RECONNECT_ATTEMPTS = 8

// ─── Backoff ─────────────────────────────────────────────────────────────

/**
 * Exponential backoff schedule for full-driver reconnect:
 *   attempt 0 → 1s
 *   attempt 1 → 2s
 *   attempt 2 → 4s
 *   attempt 3 → 8s
 *   attempt 4 → 16s
 *   attempt 5+ → 30s (cap)
 *
 * Total budget ≈ 1+2+4+8+16+30+30+30 = 121s across 8 attempts.
 */
export function computeBackoff(
  attemptsCount: number,
  capMs: number = DEFAULT_DELAYS.backoffCapMs,
): number {
  const raw = 1_000 * 2 ** attemptsCount
  return Math.min(raw, capMs)
}

// ─── Machine ─────────────────────────────────────────────────────────────

/**
 * Build a connection machine with a specific set of delays.
 *
 * Overriding delays is how tests advance timers without waiting real time —
 * pass small numbers and drive with `vi.useFakeTimers()` / `jest.useFakeTimers()`.
 */
export function createConnectionMachine(
  delays: ConnectionDelays = DEFAULT_DELAYS,
) {
  return setup({
    types: {
      context: {} as ConnectionContext,
      events: {} as ConnectionEvent,
      input: {} as ConnectionInput,
    },
    guards: {
      isReconnectOwned: ({ context }) =>
        context.adapter.ownership.reconnect === true,
      isNotReconnectOwned: ({ context }) =>
        context.adapter.ownership.reconnect === false,
      hasAttemptsRemaining: ({ context }) =>
        context.attemptsCount < MAX_RECONNECT_ATTEMPTS,
      priorPhaseIsConnected: ({ context }) => context.priorPhase === 'connected',
      priorPhaseIsScanning: ({ context }) => context.priorPhase === 'scanning',
      priorPhaseIsConnecting: ({ context }) =>
        context.priorPhase === 'connecting',
      priorPhaseIsDiscovering: ({ context }) =>
        context.priorPhase === 'discovering',
      priorPhaseIsEnabling: ({ context }) => context.priorPhase === 'enabling',
    },
    actions: {
      resetAttempts: assign({ attemptsCount: 0 }),
      incrementAttempts: assign({
        attemptsCount: ({ context }) => context.attemptsCount + 1,
      }),
      setPriorPhaseScanning: assign({ priorPhase: 'scanning' as ActivePhase }),
      setPriorPhaseConnecting: assign({
        priorPhase: 'connecting' as ActivePhase,
      }),
      setPriorPhaseDiscovering: assign({
        priorPhase: 'discovering' as ActivePhase,
      }),
      setPriorPhaseEnabling: assign({ priorPhase: 'enabling' as ActivePhase }),
      setPriorPhaseConnected: assign({ priorPhase: 'connected' as ActivePhase }),
      setPriorPhaseReconnecting: assign({
        priorPhase: 'reconnecting' as ActivePhase,
      }),
      clearPriorPhase: assign({ priorPhase: undefined }),
      recordCandidate: assign({
        candidate: ({ event }) =>
          event.type === 'SCAN_FOUND' ? event.candidate : undefined,
      }),
      recordRssi: assign({
        rssi: ({ event }) => (event.type === 'RSSI' ? event.rssi : undefined),
      }),
      setTimeoutError: assign({
        lastError: (_, params: { phase: string }) => ({
          category: 'timeout' as const,
          phase: params.phase,
          canRetry: true,
        }),
      }),
      setUnexpectedDisconnectError: assign({
        lastError: (_, params: { canRetry: boolean; phase?: string }) => ({
          category: 'unexpected-disconnect' as const,
          phase: params.phase ?? 'connected',
          canRetry: params.canRetry,
        }),
      }),
      setFailureFromEvent: assign({
        lastError: ({ event }) =>
          event.type === 'CONNECT_FAILURE' ? event.detail : undefined,
      }),
      clearError: assign({ lastError: undefined }),
    },
    delays: {
      scan: delays.scanTimeoutMs,
      connect: delays.connectTimeoutMs,
      discover: delays.discoverTimeoutMs,
      enable: delays.enableTimeoutMs,
      cancelFallback: delays.cancelFallbackMs,
      backoff: ({ context }) =>
        computeBackoff(context.attemptsCount, delays.backoffCapMs),
    },
  }).createMachine({
    id: 'connection',
    initial: 'idle',
    context: ({ input }) => ({
      deviceId: input.deviceId,
      adapter: input.adapter,
      candidate: input.candidate,
      rssi: undefined,
      elapsedMs: undefined,
      lastError: undefined,
      attemptsCount: 0,
      priorPhase: undefined,
    }),

    // Global interrupts — apply from every state.
    on: {
      BT_OFF: { target: '.suspended' },
      PERMISSION_REVOKED: { target: '.suspended' },
      BACKGROUNDED: { target: '.suspended' },
      RSSI: { actions: 'recordRssi' },
    },

    states: {
      idle: {
        on: {
          SCAN_START: { target: 'scanning' },
          CONNECT: {
            target: 'connecting',
            actions: 'resetAttempts',
          },
        },
      },

      scanning: {
        entry: 'setPriorPhaseScanning',
        after: {
          scan: {
            target: 'failed',
            actions: {
              type: 'setTimeoutError',
              params: { phase: 'scanning' },
            },
          },
        },
        on: {
          SCAN_FOUND: { actions: 'recordCandidate' },
          // Empty scan resolves to idle, NEVER failed (spec lock).
          SCAN_COMPLETE: { target: 'idle' },
          CONNECT: {
            target: 'connecting',
            actions: 'resetAttempts',
          },
          CANCEL: { target: 'cancelling' },
        },
      },

      connecting: {
        entry: 'setPriorPhaseConnecting',
        after: {
          connect: {
            target: 'failed',
            actions: {
              type: 'setTimeoutError',
              params: { phase: 'connecting' },
            },
          },
        },
        on: {
          CONNECT_SUCCESS: { target: 'discovering' },
          CONNECT_FAILURE: {
            target: 'failed',
            actions: 'setFailureFromEvent',
          },
          CANCEL: { target: 'cancelling' },
          UNEXPECTED_DISCONNECT: {
            target: 'failed',
            actions: {
              type: 'setUnexpectedDisconnectError',
              params: { canRetry: true },
            },
          },
        },
      },

      discovering: {
        entry: 'setPriorPhaseDiscovering',
        after: {
          discover: {
            target: 'failed',
            actions: {
              type: 'setTimeoutError',
              params: { phase: 'discovering' },
            },
          },
        },
        on: {
          CONNECT_SUCCESS: { target: 'enabling' },
          CONNECT_FAILURE: {
            target: 'failed',
            actions: 'setFailureFromEvent',
          },
          CANCEL: { target: 'cancelling' },
          UNEXPECTED_DISCONNECT: {
            target: 'failed',
            actions: {
              type: 'setUnexpectedDisconnectError',
              params: { canRetry: true },
            },
          },
        },
      },

      enabling: {
        entry: 'setPriorPhaseEnabling',
        after: {
          enable: {
            target: 'failed',
            actions: {
              type: 'setTimeoutError',
              params: { phase: 'enabling' },
            },
          },
        },
        on: {
          CONNECT_SUCCESS: {
            target: 'connected',
            actions: ['resetAttempts', 'clearError'],
          },
          CONNECT_FAILURE: {
            target: 'failed',
            actions: 'setFailureFromEvent',
          },
          CANCEL: { target: 'cancelling' },
          UNEXPECTED_DISCONNECT: {
            target: 'failed',
            actions: {
              type: 'setUnexpectedDisconnectError',
              params: { canRetry: true },
            },
          },
        },
      },

      cancelling: {
        after: {
          cancelFallback: { target: 'idle' },
        },
        on: {
          CONNECT_FAILURE: { target: 'idle' },
          UNEXPECTED_DISCONNECT: { target: 'idle' },
          CONNECT_SUCCESS: { target: 'idle' },
        },
      },

      connected: {
        entry: 'setPriorPhaseConnected',
        on: {
          // User-initiated: only valid on established link (see spec lock).
          DISCONNECT: {
            target: 'idle',
            actions: ['resetAttempts', 'clearError'],
          },
          // Adapter dropped link — branch on ownership.
          UNEXPECTED_DISCONNECT: [
            {
              guard: 'isReconnectOwned',
              target: 'reconnecting',
              actions: {
                type: 'setUnexpectedDisconnectError',
                params: { canRetry: true },
              },
            },
            {
              // Full-driver path: fresh attempts counter.
              target: 'reconnecting',
              actions: [
                'resetAttempts',
                {
                  type: 'setUnexpectedDisconnectError',
                  params: { canRetry: true },
                },
              ],
            },
          ],
        },
      },

      reconnecting: {
        entry: 'setPriorPhaseReconnecting',
        initial: 'branching',
        states: {
          branching: {
            always: [
              // Thin reflector — adapter drives; no timer, wait for SDK signal.
              { guard: 'isReconnectOwned', target: 'reflecting' },
              // Full driver — begin backoff loop.
              { target: 'backingOff' },
            ],
          },
          reflecting: {
            on: {
              CONNECT_SUCCESS: {
                target: '#connection.connected',
                actions: ['resetAttempts', 'clearError'],
              },
              CONNECT_FAILURE: {
                target: '#connection.failed',
                actions: 'setFailureFromEvent',
              },
            },
          },
          backingOff: {
            after: {
              backoff: [
                {
                  guard: 'hasAttemptsRemaining',
                  target: 'attempting',
                  actions: 'incrementAttempts',
                },
                {
                  // Exhausted: bail out to `failed` with canRetry:false.
                  target: '#connection.failed',
                  actions: {
                    type: 'setUnexpectedDisconnectError',
                    params: { canRetry: false },
                  },
                },
              ],
            },
          },
          attempting: {
            after: {
              connect: {
                target: 'backingOff',
                actions: {
                  type: 'setTimeoutError',
                  params: { phase: 'reconnecting' },
                },
              },
            },
            on: {
              CONNECT_SUCCESS: {
                target: '#connection.connected',
                actions: ['resetAttempts', 'clearError'],
              },
              CONNECT_FAILURE: { target: 'backingOff' },
            },
          },
        },
      },

      suspended: {
        on: {
          RESUMED: [
            // Thin reflector coming back from a live link → re-enter reconnecting,
            // since the SDK will re-establish (or re-report drop).
            {
              guard: 'priorPhaseIsConnected',
              target: 'reconnecting',
              actions: 'clearPriorPhase',
            },
            {
              guard: 'priorPhaseIsScanning',
              target: 'scanning',
              actions: 'clearPriorPhase',
            },
            {
              guard: 'priorPhaseIsConnecting',
              target: 'connecting',
              actions: 'clearPriorPhase',
            },
            {
              guard: 'priorPhaseIsDiscovering',
              target: 'discovering',
              actions: 'clearPriorPhase',
            },
            {
              guard: 'priorPhaseIsEnabling',
              target: 'enabling',
              actions: 'clearPriorPhase',
            },
            {
              // Fallback: nothing to resume; return to idle.
              target: 'idle',
              actions: 'clearPriorPhase',
            },
          ],
        },
      },

      failed: {
        on: {
          CONNECT: {
            target: 'connecting',
            actions: ['resetAttempts', 'clearError'],
          },
          CANCEL: {
            target: 'idle',
            actions: ['resetAttempts', 'clearError'],
          },
        },
      },
    },
  })
}

/** Default machine instance with typical delays. */
export const connectionMachine = createConnectionMachine()

export type ConnectionMachine = ReturnType<typeof createConnectionMachine>
