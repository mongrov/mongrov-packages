import { setup, assign } from 'xstate';
import type { CompletionContext, CompletionEvent } from '../types';

export const completionMachine = setup({
  types: {
    context: {} as CompletionContext,
    events: {} as CompletionEvent,
  },
  actions: {
    clearResult: assign({
      result: null,
    }),
    setResult: assign({
      result: ({ event }) => {
        if (event.type !== 'COMPLETE') return null;
        return event.result;
      },
    }),
    setError: assign({
      error: ({ event }) => {
        if (event.type !== 'ERROR') return null;
        return event.error;
      },
    }),
    clearError: assign({
      error: null,
    }),
    createAbortController: assign({
      abortController: () => new AbortController(),
    }),
    cancelRequest: assign({
      abortController: ({ context }) => {
        context.abortController?.abort();
        return null;
      },
    }),
    clearAbortController: assign({
      abortController: null,
    }),
  },
  guards: {
    hasPrompt: ({ event }) => {
      if (event.type !== 'GENERATE') return false;
      return event.prompt.trim().length > 0;
    },
  },
}).createMachine({
  id: 'completion',
  initial: 'idle',
  context: {
    result: null,
    error: null,
    abortController: null,
  },
  states: {
    idle: {
      on: {
        GENERATE: {
          target: 'loading',
          guard: 'hasPrompt',
          actions: ['clearError', 'clearResult', 'createAbortController'],
        },
      },
    },
    loading: {
      on: {
        COMPLETE: {
          target: 'idle',
          actions: ['setResult', 'clearAbortController'],
        },
        CANCEL: {
          target: 'idle',
          actions: ['cancelRequest', 'clearAbortController'],
        },
        ERROR: {
          target: 'error',
          actions: ['setError', 'clearAbortController'],
        },
      },
    },
    error: {
      on: {
        GENERATE: {
          target: 'loading',
          guard: 'hasPrompt',
          actions: ['clearError', 'clearResult', 'createAbortController'],
        },
      },
    },
  },
});

export type CompletionMachine = typeof completionMachine;
