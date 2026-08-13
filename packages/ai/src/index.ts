// Client
export { createAIClient } from './ai-client'
// Provider
export { AIProvider, useAIClient, useAIConfig, useAIContext } from './ai-provider'

export type { AIProviderProps } from './ai-provider'
// Types
export type {
  AIClient,
  AIConfig,
  AILogger,
  ChatScreenProps,
  ChatTheme,
  Message,
  MessageRole,
  QuickReplyBarProps,
  StreamingTextProps,
  UseAIChatReturn,
  UseAICompletionReturn,
} from './types'

// Hooks
export { useAIChat } from './use-ai-chat'

export { useAICompletion } from './use-ai-completion'
