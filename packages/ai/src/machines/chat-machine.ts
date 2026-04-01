import { setup, assign } from 'xstate';
import type { ChatContext, ChatEvent, Message } from '../types';

function generateId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export const chatMachine = setup({
  types: {
    context: {} as ChatContext,
    events: {} as ChatEvent,
  },
  actions: {
    addUserMessage: assign({
      messages: ({ context, event }) => {
        if (event.type !== 'SEND') return context.messages;
        const userMessage: Message = {
          id: generateId(),
          role: 'user',
          content: event.content,
          createdAt: new Date(),
        };
        return [...context.messages, userMessage];
      },
    }),
    startAssistantMessage: assign({
      messages: ({ context }) => {
        const assistantMessage: Message = {
          id: generateId(),
          role: 'assistant',
          content: '',
          createdAt: new Date(),
        };
        return [...context.messages, assistantMessage];
      },
      currentStreamedContent: '',
    }),
    appendStreamChunk: assign({
      currentStreamedContent: ({ context, event }) => {
        if (event.type !== 'STREAM_CHUNK') return context.currentStreamedContent;
        return context.currentStreamedContent + event.chunk;
      },
      messages: ({ context, event }) => {
        if (event.type !== 'STREAM_CHUNK') return context.messages;
        const messages = [...context.messages];
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.role === 'assistant') {
          messages[messages.length - 1] = {
            ...lastMessage,
            content: context.currentStreamedContent + event.chunk,
          };
        }
        return messages;
      },
    }),
    finalizeStream: assign({
      currentStreamedContent: '',
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
    setMessages: assign({
      messages: ({ event }) => {
        if (event.type !== 'SET_MESSAGES') return [];
        return event.messages;
      },
    }),
    clearMessages: assign({
      messages: [],
      currentStreamedContent: '',
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
    hasContent: ({ event }) => {
      if (event.type !== 'SEND') return false;
      return event.content.trim().length > 0;
    },
  },
}).createMachine({
  id: 'chat',
  initial: 'idle',
  context: {
    messages: [],
    currentStreamedContent: '',
    error: null,
    abortController: null,
  },
  states: {
    idle: {
      on: {
        SEND: {
          target: 'sending',
          guard: 'hasContent',
          actions: ['clearError', 'createAbortController', 'addUserMessage', 'startAssistantMessage'],
        },
        SET_MESSAGES: {
          actions: 'setMessages',
        },
        CLEAR_MESSAGES: {
          actions: 'clearMessages',
        },
      },
    },
    sending: {
      on: {
        STREAM_CHUNK: {
          actions: 'appendStreamChunk',
        },
        STREAM_COMPLETE: {
          target: 'idle',
          actions: ['finalizeStream', 'clearAbortController'],
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
        SEND: {
          target: 'sending',
          guard: 'hasContent',
          actions: ['clearError', 'createAbortController', 'addUserMessage', 'startAssistantMessage'],
        },
        SET_MESSAGES: {
          target: 'idle',
          actions: 'setMessages',
        },
        CLEAR_MESSAGES: {
          target: 'idle',
          actions: 'clearMessages',
        },
      },
    },
  },
});

export type ChatMachine = typeof chatMachine;
