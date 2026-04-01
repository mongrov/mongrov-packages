// Components
export { ChatScreen } from './ChatScreen';
export { StreamingText } from './StreamingText';
export { QuickReplyBar } from './QuickReplyBar';
export { ChatEmptyState } from './ChatEmptyState';
export type { ChatEmptyStateProps } from './ChatEmptyState';

// Message adapter (for custom integrations)
export {
  toGiftedMessage,
  fromGiftedMessage,
  toGiftedMessages,
  fromGiftedMessages,
} from './message-adapter';
export type { GiftedMessage, AdapterConfig } from './message-adapter';

// Re-export types for convenience
export type {
  ChatScreenProps,
  StreamingTextProps,
  QuickReplyBarProps,
} from '../types';
