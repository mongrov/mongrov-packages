/**
 * XState v5 state machine that drives the analytics engine lifecycle.
 *
 * `idle → opening → ready → attaching → attached → detaching → error`
 *
 * The machine owns lifecycle transitions only; side effects live in injected
 * actors (`openEngine`, `attachEngine`, `detachEngine`, `refreshToken`) so
 * tests can substitute fakes without a real DuckDB.
 *
 * Token refresh runs silently on `attached` via a delayed self-transition
 * to `refreshing`, computed as 75% of the remaining TTL (spec §Token
 * refresh policy). Refresh success re-enters `attached` and re-arms the
 * timer; failure lands in `error`.
 *
 * Consumers (T-10 factory + T-11 hook) drive the machine via `send` and
 * observe via `subscribe`.
 */

import { assign, fromPromise, setup } from 'xstate'

import { AnalyticsError } from './errors'
import type { AttachContext } from './types'

// -------------------- token TTL math --------------------

/**
 * Compute the delay before firing `TOKEN_REFRESH_TICK`. Spec calls for 75%
 * TTL. Falls back to a 30-minute default when the vendor's `expiresAt` is
 * missing or already in the past — the refresh will fail loudly rather than
 * silently skipping.
 */
export function computeRefreshDelay(now: number, expiresAt: number | undefined): number {
  if (typeof expiresAt !== 'number' || expiresAt <= now) {
    return 30 * 60 * 1000
  }
  const ttl = expiresAt - now
  return Math.max(Math.floor(ttl * 0.75), 1)
}

// -------------------- actor deps + shape --------------------

export interface AttachSuccess {
  warehouseSecret: string
  tokenExpiresAt: number
}

export interface RefreshSuccess {
  tokenExpiresAt: number
}

/**
 * Actors are injected by the factory (T-10). Each returns a promise the
 * machine invokes on entry to the relevant state.
 */
export interface MachineActors {
  openEngine: () => Promise<void>
  attachEngine: (input: { ctx: AttachContext }) => Promise<AttachSuccess>
  detachEngine: (input: { ctx: AttachContext }) => Promise<void>
  refreshToken: (input: { ctx: AttachContext }) => Promise<RefreshSuccess>
}

// -------------------- context + events --------------------

export interface MachineContext {
  deps: MachineActors
  ctx: AttachContext | undefined
  tokenExpiresAt: number | undefined
  warehouseSecret: string | undefined
  lastError: AnalyticsError | undefined
}

export type MachineEvent =
  | { type: 'OPEN' }
  | { type: 'ATTACH'; ctx: AttachContext }
  | { type: 'DETACH' }
  | { type: 'CLOSE' }
  | { type: 'TOKEN_REFRESH_TICK' }

export interface MachineInput {
  deps: MachineActors
}

export type MachineState =
  | 'idle'
  | 'opening'
  | 'ready'
  | 'attaching'
  | 'attached'
  | 'refreshing'
  | 'detaching'
  | 'error'

// -------------------- error normalisation --------------------

function toAnalyticsError(
  cause: unknown,
  fallbackCode: 'engine_open_failed' | 'attach_failed' | 'token_vendor_failed',
): AnalyticsError {
  if (cause instanceof AnalyticsError) {
    return cause
  }
  return new AnalyticsError(fallbackCode, `machine actor failed: ${String(cause)}`, cause)
}

// -------------------- machine --------------------

export const analyticsMachine = setup({
  types: {
    context: {} as MachineContext,
    events: {} as MachineEvent,
    input: {} as MachineInput,
  },
  actors: {
    openEngine: fromPromise<void, { deps: MachineActors }>(async ({ input }) => {
      await input.deps.openEngine()
    }),
    attachEngine: fromPromise<AttachSuccess, { deps: MachineActors; ctx: AttachContext }>(
      async ({ input }) => input.deps.attachEngine({ ctx: input.ctx }),
    ),
    detachEngine: fromPromise<void, { deps: MachineActors; ctx: AttachContext }>(
      async ({ input }) => {
        await input.deps.detachEngine({ ctx: input.ctx })
      },
    ),
    refreshToken: fromPromise<RefreshSuccess, { deps: MachineActors; ctx: AttachContext }>(
      async ({ input }) => input.deps.refreshToken({ ctx: input.ctx }),
    ),
  },
  actions: {
    assignAttachCtx: assign(({ event }) => {
      if (event.type !== 'ATTACH') return {}
      return { ctx: event.ctx }
    }),
    assignAttachSuccess: assign((_, params: { output: AttachSuccess }) => ({
      warehouseSecret: params.output.warehouseSecret,
      tokenExpiresAt: params.output.tokenExpiresAt,
      lastError: undefined,
    })),
    assignRefreshSuccess: assign((_, params: { output: RefreshSuccess }) => ({
      tokenExpiresAt: params.output.tokenExpiresAt,
      lastError: undefined,
    })),
    assignOpenError: assign((_, params: { error: unknown }) => ({
      lastError: toAnalyticsError(params.error, 'engine_open_failed'),
    })),
    assignAttachError: assign((_, params: { error: unknown }) => ({
      lastError: toAnalyticsError(params.error, 'attach_failed'),
    })),
    assignRefreshError: assign((_, params: { error: unknown }) => ({
      lastError: toAnalyticsError(params.error, 'token_vendor_failed'),
    })),
    clearError: assign({ lastError: undefined }),
    clearAttachState: assign({
      ctx: undefined,
      tokenExpiresAt: undefined,
      warehouseSecret: undefined,
    }),
  },
  guards: {
    hasAttachCtx: ({ context }) => context.ctx !== undefined,
  },
  delays: {
    tokenRefresh: ({ context }) => computeRefreshDelay(Date.now(), context.tokenExpiresAt),
  },
}).createMachine({
  id: 'analytics',
  initial: 'idle',
  context: ({ input }) => ({
    deps: input.deps,
    ctx: undefined,
    tokenExpiresAt: undefined,
    warehouseSecret: undefined,
    lastError: undefined,
  }),
  on: {
    CLOSE: {
      target: '.idle',
      actions: ['clearAttachState', 'clearError'],
    },
  },
  states: {
    idle: {
      on: {
        OPEN: 'opening',
      },
    },
    opening: {
      invoke: {
        src: 'openEngine',
        input: ({ context }) => ({ deps: context.deps }),
        onDone: 'ready',
        onError: {
          target: 'error',
          actions: {
            type: 'assignOpenError',
            params: ({ event }) => ({ error: event.error }),
          },
        },
      },
    },
    ready: {
      on: {
        ATTACH: {
          target: 'attaching',
          actions: 'assignAttachCtx',
        },
      },
    },
    attaching: {
      invoke: {
        src: 'attachEngine',
        input: ({ context }) => ({ deps: context.deps, ctx: context.ctx! }),
        onDone: {
          target: 'attached',
          actions: {
            type: 'assignAttachSuccess',
            params: ({ event }) => ({ output: event.output }),
          },
        },
        onError: {
          target: 'error',
          actions: {
            type: 'assignAttachError',
            params: ({ event }) => ({ error: event.error }),
          },
        },
      },
    },
    attached: {
      after: {
        tokenRefresh: {
          target: 'refreshing',
        },
      },
      on: {
        TOKEN_REFRESH_TICK: 'refreshing',
        DETACH: 'detaching',
      },
    },
    refreshing: {
      invoke: {
        src: 'refreshToken',
        input: ({ context }) => ({ deps: context.deps, ctx: context.ctx! }),
        onDone: {
          target: 'attached',
          actions: {
            type: 'assignRefreshSuccess',
            params: ({ event }) => ({ output: event.output }),
          },
        },
        onError: {
          target: 'error',
          actions: {
            type: 'assignRefreshError',
            params: ({ event }) => ({ error: event.error }),
          },
        },
      },
    },
    detaching: {
      invoke: {
        src: 'detachEngine',
        input: ({ context }) => ({ deps: context.deps, ctx: context.ctx! }),
        onDone: {
          target: 'ready',
          actions: 'clearAttachState',
        },
        onError: {
          target: 'error',
          actions: {
            type: 'assignAttachError',
            params: ({ event }) => ({ error: event.error }),
          },
        },
      },
    },
    error: {
      on: {
        OPEN: {
          target: 'opening',
          actions: 'clearError',
        },
        ATTACH: [
          {
            guard: 'hasAttachCtx',
            target: 'attaching',
            actions: ['assignAttachCtx', 'clearError'],
          },
          {
            target: 'attaching',
            actions: ['assignAttachCtx', 'clearError'],
          },
        ],
      },
    },
  },
})
