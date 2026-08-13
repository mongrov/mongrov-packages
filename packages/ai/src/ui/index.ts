// Re-export types for convenience
export type {
  ChatScreenProps,
  QuickReplyBarProps,
  StreamingTextProps,
} from '../types'
export { ChatEmptyState } from './ChatEmptyState'
export type { ChatEmptyStateProps } from './ChatEmptyState'
// Components
export { ChatScreen } from './ChatScreen'
// Message adapter (for custom integrations)
export {
  fromGiftedMessage,
  fromGiftedMessages,
  toGiftedMessage,
  toGiftedMessages,
} from './message-adapter'

export type { AdapterConfig, GiftedMessage } from './message-adapter'
export { QuickReplyBar } from './QuickReplyBar'

export { StreamingText } from './StreamingText'
