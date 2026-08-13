import type { CoreTool, LanguageModelV1 } from 'ai';

// Logger interface (injectable, same pattern as auth)
export interface AILogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// AI Configuration
export interface AIConfig {
  model: LanguageModelV1;
  logger?: AILogger;
  systemPrompt?: string;
  /**
   * Optional tool map (AI SDK v4 `CoreTool`) threaded to both
   * `streamText` and `generateText`. Consumers hand a map from
   * `@mongrov/analytics/tools`'s `createAnalyticsTools` or any other
   * AI SDK-compatible tool factory.
   */
  tools?: Record<string, CoreTool>;
}

// Message types (AI SDK compatible)
export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt?: Date;
}

// Chat hook return type
export interface UseAIChatReturn {
  messages: Message[];
  send: (content: string) => Promise<void>;
  isStreaming: boolean;
  cancel: () => void;
  error: Error | null;
  setMessages: (messages: Message[] | ((prev: Message[]) => Message[])) => void;
  clearMessages: () => void;
}

// Completion hook return type
export interface UseAICompletionReturn {
  result: string | null;
  generate: (prompt: string) => Promise<string>;
  isLoading: boolean;
  cancel: () => void;
  error: Error | null;
}

// AI Client interface
export interface AIClient {
  chat: (messages: Message[]) => AsyncGenerator<string, void, unknown>;
  complete: (prompt: string) => Promise<string>;
  cancel: () => void;
}

// Machine context types
export interface ChatContext {
  messages: Message[];
  currentStreamedContent: string;
  error: Error | null;
  abortController: AbortController | null;
}

export interface CompletionContext {
  result: string | null;
  error: Error | null;
  abortController: AbortController | null;
}

// Machine event types
export type ChatEvent =
  | { type: 'SEND'; content: string }
  | { type: 'STREAM_CHUNK'; chunk: string }
  | { type: 'STREAM_COMPLETE' }
  | { type: 'CANCEL' }
  | { type: 'ERROR'; error: Error }
  | { type: 'SET_MESSAGES'; messages: Message[] }
  | { type: 'CLEAR_MESSAGES' };

export type CompletionEvent =
  | { type: 'GENERATE'; prompt: string }
  | { type: 'COMPLETE'; result: string }
  | { type: 'CANCEL' }
  | { type: 'ERROR'; error: Error };

// Chat Screen props (UI layer)
export interface ChatScreenProps {
  placeholder?: string;
  emptyTitle?: string;
  emptySubtitle?: string;
  quickReplies?: string[];
  assistantName?: string;
  assistantAvatar?: string | number;
  onSend?: (message: string) => void;
  /**
   * Override the few colours that cannot be classNames — see `ChatTheme`.
   *
   * Rarely needed: the defaults follow the consumer's semantic tokens. Merged
   * over them, so pass only what differs.
   */
  theme?: Partial<ChatTheme>;
  testID?: string;
}

/**
 * The colours ChatScreen cannot express as classNames.
 *
 * Everything the component renders itself is styled with uniwind classNames
 * resolved from the consumer's semantic tokens, so it follows the app's theme
 * and brand automatically. Two things resist that and are all this covers:
 *
 *   - `placeholderTextColor` is a React Native prop taking a raw colour
 *   - gifted-chat's `Bubble` takes `wrapperStyle` / `textStyle` objects
 *
 * Defaults track `--color-muted`, `--color-muted-foreground` and
 * `--color-primary`, so passing nothing still looks native.
 */
export interface ChatTheme {
  placeholder: string;
  userBubble: string;
  userText: string;
  assistantBubble: string;
  assistantText: string;
}

// Streaming text props
export interface StreamingTextProps {
  text: string;
  isStreaming?: boolean;
  cursorChar?: string;
  className?: string;
  testID?: string;
}

// Quick reply bar props
export interface QuickReplyBarProps {
  replies: string[];
  onSelect: (reply: string) => void;
  testID?: string;
}
