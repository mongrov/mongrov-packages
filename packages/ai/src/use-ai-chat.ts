import type { Message, UseAIChatReturn } from './types'
import { useMachine } from '@xstate/react'
import { useCallback, useMemo } from 'react'
import { useAIClient, useAIConfig } from './ai-provider'
import { chatMachine } from './machines/chat-machine'

export function useAIChat(): UseAIChatReturn {
  const client = useAIClient()
  const { logger } = useAIConfig()
  const [state, send] = useMachine(chatMachine)

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim())
        return

      send({ type: 'SEND', content })

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
        ]

        const stream = client.chat(currentMessages)

        for await (const chunk of stream) {
          send({ type: 'STREAM_CHUNK', chunk })
        }

        send({ type: 'STREAM_COMPLETE' })
      }
      catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        // Log as well as store it. The machine's context is only visible to
        // whatever reads `error` off this hook; a caller that ignores it —
        // which ChatScreen did until 0.4.1 — turns a failed request into
        // silence, with no trace in Metro either.
        logger?.error?.('[ai] chat request failed', { message: error.message })
        send({ type: 'ERROR', error })
      }
    },
    [client, send, logger, state.context.messages],
  )

  const cancel = useCallback(() => {
    client.cancel()
    send({ type: 'CANCEL' })
  }, [client, send])

  const setMessages = useCallback(
    (messagesOrUpdater: Message[] | ((prev: Message[]) => Message[])) => {
      const newMessages
        = typeof messagesOrUpdater === 'function'
          ? messagesOrUpdater(state.context.messages)
          : messagesOrUpdater
      send({ type: 'SET_MESSAGES', messages: newMessages })
    },
    [send, state.context.messages],
  )

  const clearMessages = useCallback(() => {
    send({ type: 'CLEAR_MESSAGES' })
  }, [send])

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
    ],
  )

  return result
}
