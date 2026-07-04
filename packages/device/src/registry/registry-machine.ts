/**
 * registry-machine — parent of per-device connection actors.
 *
 * Responsibilities (design.md §6.1):
 *   - Spawns / cleans up a `connectionMachine` actor per deviceId
 *   - Fans SCAN_START out to every adapter with `ownership.scan === true`
 *   - Aggregates scan candidates from multiple adapters
 *   - Routes SCAN_HIT to the first adapter whose `canHandle` returns true
 *   - Enforces the shared `maxConnections` pool (user-connect + sync share the
 *     same slots) → 'slot-full' rejection instead of spawning
 *   - Broadcasts global interrupts (BT_OFF / PERMISSION_REVOKED /
 *     BACKGROUNDED / RESUMED) to every child actor
 *
 * No React, no db, no vendor SDK. Actors are XState v5 `ActorRef`s stored in
 * a plain `Map` inside context for O(1) lookup by deviceId.
 */

import type { ActorRefFrom } from 'xstate'
import { assign, setup, sendTo, stopChild } from 'xstate'

import type {
  DeviceAdapter,
  ErrorDetail,
  ScanCandidate,
} from '../types'

import {
  DEFAULT_DELAYS,
  createConnectionMachine,
  type ConnectionDelays,
} from './connection-machine'

type ConnectionMachineLogic = ReturnType<typeof createConnectionMachine>

// ─── Types ───────────────────────────────────────────────────────────────

export type ConnectionActorRef = ActorRefFrom<
  ReturnType<typeof createConnectionMachine>
>

export type ScanState = 'idle' | 'scanning'

export interface RegistryContext {
  adapters: DeviceAdapter[]
  connectionActors: Map<string, ConnectionActorRef>
  maxConnections: number
  activeConnections: number
  scanState: ScanState
  scanCandidates: Map<string, ScanCandidate>
  /**
   * Set on SCAN_STOP. Lets ux distinguish "scanned and got 0" (→ `none`)
   * from "never scanned" (→ initial idle). scanCandidates.size alone is
   * insufficient. Cleared by SCAN_START.
   */
  lastScanFinishedAt: number | undefined
  lastRejection: ErrorDetail | undefined
}

export interface RegistryInput {
  adapters: DeviceAdapter[]
  /** Shared pool for user-connect AND sync runs; defaults to 4. */
  maxConnections?: number
  /** Overridable delays passed to spawned connection machines. */
  connectionDelays?: ConnectionDelays
}

export type RegistryEvent =
  | { type: 'SCAN_START' }
  | { type: 'SCAN_STOP' }
  | { type: 'SCAN_HIT'; candidate: ScanCandidate }
  | { type: 'CONNECT_REQUEST'; deviceId: string; candidate?: ScanCandidate }
  | { type: 'DISCONNECT_REQUEST'; deviceId: string }
  | {
      type: 'CONNECTION_STATE_CHANGED'
      deviceId: string
      state: 'idle' | 'connected'
    }
  | { type: 'BT_OFF' }
  | { type: 'PERMISSION_REVOKED' }
  | { type: 'BACKGROUNDED' }
  | { type: 'RESUMED' }

// ─── Machine ─────────────────────────────────────────────────────────────

export function createRegistryMachine(
  defaultConnectionDelays: ConnectionDelays = DEFAULT_DELAYS,
) {
  const connectionMachineFactory = createConnectionMachine(
    defaultConnectionDelays,
  )

  return setup({
    types: {
      context: {} as RegistryContext,
      events: {} as RegistryEvent,
      input: {} as RegistryInput,
    },
    actors: {
      connectionMachine: connectionMachineFactory,
    },
    guards: {
      hasSlotAvailable: ({ context }) =>
        context.activeConnections < context.maxConnections,
      actorExistsForRequest: ({ context, event }) => {
        if (event.type !== 'CONNECT_REQUEST') return false
        return context.connectionActors.has(event.deviceId)
      },
      actorMissingForRequest: ({ context, event }) => {
        if (event.type !== 'CONNECT_REQUEST') return true
        return !context.connectionActors.has(event.deviceId)
      },
    },
    actions: {
      // Route a scan candidate to the first adapter that claims it.
      // `canHandle` is iterated in registration order; first match wins.
      routeScanHit: assign(({ context, event }) => {
        if (event.type !== 'SCAN_HIT') return {}
        const owning = context.adapters.find((a) => a.canHandle(event.candidate))
        if (!owning) return {}
        const next = new Map(context.scanCandidates)
        next.set(event.candidate.id, event.candidate)
        return { scanCandidates: next }
      }),

      startScanFanout: ({ context }) => {
        // Fan out to every adapter with ownership.scan === true.
        // The parent captures aggregated hits via SCAN_HIT — adapter callbacks
        // are wired externally (see interrupts / device-client glue).
        for (const adapter of context.adapters) {
          if (adapter.ownership.scan && adapter.startScan) {
            void adapter.startScan(() => {
              /* candidates arrive via SCAN_HIT event injected by glue */
            })
          }
        }
      },

      stopScanFanout: ({ context }) => {
        for (const adapter of context.adapters) {
          if (adapter.ownership.scan && adapter.stopScan) {
            void adapter.stopScan()
          }
        }
      },

      setScanning: assign({ scanState: 'scanning' as ScanState }),
      setIdle: assign({ scanState: 'idle' as ScanState }),
      stampScanFinished: assign({ lastScanFinishedAt: () => Date.now() }),
      clearScanFinished: assign({ lastScanFinishedAt: undefined }),
      clearScanCandidates: assign({
        scanCandidates: () => new Map<string, ScanCandidate>(),
      }),
      clearRejection: assign({ lastRejection: undefined }),

      recordSlotFullRejection: assign({
        lastRejection: {
          category: 'slot-full' as const,
          phase: 'connect-request',
          canRetry: true,
        },
      }),

      // Spawn a per-device connection actor.
      spawnConnectionActor: assign(({ context, event, spawn }) => {
        if (event.type !== 'CONNECT_REQUEST') return {}
        if (context.connectionActors.has(event.deviceId)) return {}

        const adapter =
          context.adapters.find((a) =>
            event.candidate ? a.canHandle(event.candidate) : true,
          ) ?? context.adapters[0]

        if (!adapter) return {}

        const actor = spawn('connectionMachine', {
          id: `connection:${event.deviceId}`,
          input: {
            deviceId: event.deviceId,
            adapter,
            candidate: event.candidate,
          },
        }) as ConnectionActorRef

        const next = new Map(context.connectionActors)
        next.set(event.deviceId, actor)

        return {
          connectionActors: next,
          activeConnections: context.activeConnections + 1,
        }
      }),

      // Ask the (freshly-spawned or already-present) child to CONNECT.
      forwardConnect: sendTo(
        ({ context, event }) => {
          if (event.type !== 'CONNECT_REQUEST') {
            throw new Error('forwardConnect requires CONNECT_REQUEST event')
          }
          const ref = context.connectionActors.get(event.deviceId)
          if (!ref) throw new Error('actor not spawned')
          return ref
        },
        ({ event }) => {
          if (event.type !== 'CONNECT_REQUEST') {
            throw new Error('unreachable')
          }
          return { type: 'CONNECT' as const, candidate: event.candidate }
        },
      ),

      forwardDisconnect: sendTo(
        ({ context, event }) => {
          if (event.type !== 'DISCONNECT_REQUEST') {
            throw new Error('forwardDisconnect requires DISCONNECT_REQUEST')
          }
          const ref = context.connectionActors.get(event.deviceId)
          if (!ref) throw new Error('actor missing')
          return ref
        },
        { type: 'DISCONNECT' as const },
      ),

      // Reap children whose state has returned to idle (post-disconnect or
      // terminal failure that the app has acknowledged).
      reapIdleActor: assign(({ context, event }) => {
        if (event.type !== 'CONNECTION_STATE_CHANGED') return {}
        if (event.state !== 'idle') return {}
        if (!context.connectionActors.has(event.deviceId)) return {}
        const next = new Map(context.connectionActors)
        next.delete(event.deviceId)
        return {
          connectionActors: next,
          activeConnections: Math.max(0, context.activeConnections - 1),
        }
      }),

      stopReapedActor: stopChild(({ event }) => {
        if (event.type !== 'CONNECTION_STATE_CHANGED') {
          throw new Error('stopReapedActor requires CONNECTION_STATE_CHANGED')
        }
        return `connection:${event.deviceId}`
      }),

      // Broadcast global interrupts to every child actor.
      broadcastBtOff: ({ context, self }) => {
        for (const actor of context.connectionActors.values()) {
          actor.send({ type: 'BT_OFF' })
        }
        // self reference kept for future upstream signalling; intentionally unused.
        void self
      },
      broadcastPermissionRevoked: ({ context }) => {
        for (const actor of context.connectionActors.values()) {
          actor.send({ type: 'PERMISSION_REVOKED' })
        }
      },
      broadcastBackgrounded: ({ context }) => {
        for (const actor of context.connectionActors.values()) {
          actor.send({ type: 'BACKGROUNDED' })
        }
      },
      broadcastResumed: ({ context }) => {
        for (const actor of context.connectionActors.values()) {
          actor.send({ type: 'RESUMED' })
        }
      },
    },
  }).createMachine({
    id: 'registry',
    context: ({ input }) => ({
      adapters: input.adapters,
      connectionActors: new Map(),
      maxConnections: input.maxConnections ?? 4,
      activeConnections: 0,
      scanState: 'idle' as ScanState,
      scanCandidates: new Map(),
      lastScanFinishedAt: undefined,
      lastRejection: undefined,
    }),
    on: {
      SCAN_START: {
        actions: [
          'setScanning',
          'clearScanCandidates',
          'clearScanFinished',
          'startScanFanout',
        ],
      },
      SCAN_STOP: {
        actions: ['setIdle', 'stopScanFanout', 'stampScanFinished'],
      },
      SCAN_HIT: {
        actions: 'routeScanHit',
      },
      CONNECT_REQUEST: [
        // Already tracked → forward CONNECT to existing child (no re-spawn).
        {
          guard: 'actorExistsForRequest',
          actions: ['clearRejection', 'forwardConnect'],
        },
        // No slot → reject with slot-full (no spawn, no throw).
        {
          guard: ({ context }) =>
            context.activeConnections >= context.maxConnections,
          actions: 'recordSlotFullRejection',
        },
        // Fresh spawn + forward CONNECT.
        {
          actions: [
            'clearRejection',
            'spawnConnectionActor',
            'forwardConnect',
          ],
        },
      ],
      DISCONNECT_REQUEST: {
        actions: 'forwardDisconnect',
      },
      CONNECTION_STATE_CHANGED: {
        actions: ['stopReapedActor', 'reapIdleActor'],
      },
      BT_OFF: { actions: 'broadcastBtOff' },
      PERMISSION_REVOKED: { actions: 'broadcastPermissionRevoked' },
      BACKGROUNDED: { actions: 'broadcastBackgrounded' },
      RESUMED: { actions: 'broadcastResumed' },
    },
  })
}

export const registryMachine = createRegistryMachine()
export type RegistryMachine = ReturnType<typeof createRegistryMachine>
