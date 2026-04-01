import { useCallback, useMemo } from 'react';
import { useMachine } from '@xstate/react';
import { chatMachine } from './machines/chat-machine';
import { useAIClient } from './ai-provider';
import type { Message, UseAIChatReturn } from './types';

export function useAIChat(): UseAIChatReturn {
  const client = useAIClient();
  const [state, send] = useMachine(chatMachine);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;

      send({ type: 'SEND', content });

      try {
        // Get current messages including the new user message
        const currentMessages = [
          ...state.context.messages,
          {
            id: `temp_${Date.now()}`,
            role: 'user' as const,
            content,
            createdAt: new Date(),
          },
        ];

        const stream = client.chat(currentMessages);

        for await (const chunk of stream) {
          send({ type: 'STREAM_CHUNK', chunk });
        }

        send({ type: 'STREAM_COMPLETE' });
      } catch (error) {
        send({
          type: 'ERROR',
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },
    [client, send, state.context.messages]
  );

  const cancel = useCallback(() => {
    client.cancel();
    send({ type: 'CANCEL' });
  }, [client, send]);

  const setMessages = useCallback(
    (messagesOrUpdater: Message[] | ((prev: Message[]) => Message[])) => {
      const newMessages =
        typeof messagesOrUpdater === 'function'
          ? messagesOrUpdater(state.context.messages)
          : messagesOrUpdater;
      send({ type: 'SET_MESSAGES', messages: newMessages });
    },
    [send, state.context.messages]
  );

  const clearMessages = useCallback(() => {
    send({ type: 'CLEAR_MESSAGES' });
  }, [send]);

  const result = useMemo<UseAIChatReturn>(
    () => ({
      messages: state.context.messages,
      send: sendMessage,
      isStreaming: state.matches('sending'),
      cancel,
      error: state.context.error,
      setMessages,
      clearMessages,
    }),
    [
      state.context.messages,
      state.context.error,
      state.value,
      sendMessage,
      cancel,
      setMessages,
      clearMessages,
    ]
  );

  return result;
}
