import { setup, assign } from 'xstate';
import type { AuthError, UserInfo } from '../types';

// --- Context ---
export interface AuthMachineContext {
  user: UserInfo | null;
  error: AuthError | null;
  accessToken: string | null;
  refreshToken: string | null;
  isHydrated: boolean;
  /** @internal Tracks whether the current authenticating state was entered via hydrate or signIn */
  _flow: 'none' | 'hydrate' | 'signIn';
}

// --- Events ---
export type AuthMachineEvent =
  | { type: 'HYDRATE_START' }
  | { type: 'HYDRATE_SUCCESS'; user: UserInfo; accessToken: string; refreshToken: string | null }
  | { type: 'HYDRATE_NO_TOKENS' }
  | { type: 'HYDRATE_FAILURE'; error: AuthError }
  | { type: 'SET_HYDRATED' }
  | { type: 'SIGN_IN' }
  | { type: 'SIGN_IN_SUCCESS'; user: UserInfo; accessToken: string; refreshToken: string | null }
  | { type: 'SIGN_IN_FAILURE'; error: AuthError }
  | { type: 'SIGN_OUT' }
  | { type: 'TOKEN_REFRESHED'; accessToken: string; refreshToken: string | null }
  | { type: 'REFRESH_FAILED' };

export const authMachine = setup({
  types: {
    context: {} as AuthMachineContext,
    events: {} as AuthMachineEvent,
  },
  guards: {
    isHydrateFlow: ({ context }) => context._flow === 'hydrate',
    isSignInFlow: ({ context }) => context._flow === 'signIn',
  },
}).createMachine({
  id: 'auth',
  initial: 'idle',
  context: {
    user: null,
    error: null,
    accessToken: null,
    refreshToken: null,
    isHydrated: false,
    _flow: 'none',
  },
  states: {
    idle: {
      on: {
        HYDRATE_START: {
          target: 'authenticating',
          actions: assign({ _flow: 'hydrate' }),
        },
        SIGN_IN: {
          target: 'authenticating',
          actions: assign({ _flow: 'signIn' }),
        },
      },
    },
    authenticating: {
      on: {
        // signIn during hydration: switch flow, hydrate completion events will be ignored
        SIGN_IN: {
          target: 'authenticating',
          actions: assign({ _flow: 'signIn' }),
        },
        SIGN_IN_SUCCESS: {
          guard: 'isSignInFlow',
          target: 'authenticated',
          actions: assign(({ event }) => ({
            user: event.user,
            error: null,
            accessToken: event.accessToken,
            refreshToken: event.refreshToken,
            _flow: 'none' as const,
          })),
        },
        SIGN_IN_FAILURE: {
          guard: 'isSignInFlow',
          target: 'error',
          actions: assign(({ event }) => ({
            error: event.error,
            user: null,
            accessToken: null,
            refreshToken: null,
            _flow: 'none' as const,
          })),
        },
        HYDRATE_SUCCESS: {
          guard: 'isHydrateFlow',
          target: 'authenticated',
          actions: assign(({ event }) => ({
            user: event.user,
            error: null,
            accessToken: event.accessToken,
            refreshToken: event.refreshToken,
            _flow: 'none' as const,
          })),
        },
        HYDRATE_NO_TOKENS: {
          guard: 'isHydrateFlow',
          target: 'idle',
          actions: assign(() => ({
            user: null,
            error: null,
            accessToken: null,
            refreshToken: null,
            _flow: 'none' as const,
          })),
        },
        HYDRATE_FAILURE: {
          guard: 'isHydrateFlow',
          target: 'error',
          actions: assign(({ event }) => ({
            error: event.error,
            user: null,
            accessToken: null,
            refreshToken: null,
            _flow: 'none' as const,
          })),
        },
      },
    },
    authenticated: {
      on: {
        SIGN_OUT: {
          target: 'idle',
          actions: assign(() => ({
            user: null,
            error: null,
            accessToken: null,
            refreshToken: null,
            _flow: 'none' as const,
          })),
        },
        TOKEN_REFRESHED: {
          actions: assign(({ event }) => ({
            accessToken: event.accessToken,
            refreshToken: event.refreshToken,
          })),
        },
        REFRESH_FAILED: {
          target: 'idle',
          actions: assign(() => ({
            user: null,
            error: null,
            accessToken: null,
            refreshToken: null,
            _flow: 'none' as const,
          })),
        },
      },
    },
    error: {
      on: {
        SIGN_IN: {
          target: 'authenticating',
          actions: assign({ _flow: 'signIn' }),
        },
        HYDRATE_START: {
          target: 'authenticating',
          actions: assign({ _flow: 'hydrate' }),
        },
      },
    },
  },
  // SET_HYDRATED can happen from any state (called in finally block)
  on: {
    SET_HYDRATED: {
      actions: assign({ isHydrated: true }),
    },
  },
});

export type AuthMachineSnapshot = ReturnType<typeof authMachine.getInitialSnapshot>;
