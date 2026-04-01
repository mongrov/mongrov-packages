import type { Message } from '../types';

// Gifted Chat message format
export interface GiftedMessage {
  _id: string | number;
  text: string;
  createdAt: Date | number;
  user: {
    _id: string | number;
    name?: string;
    avatar?: string | number;
  };
}

export interface AdapterConfig {
  userId?: string | number;
  userName?: string;
  userAvatar?: string | number;
  assistantId?: string | number;
  assistantName?: string;
  assistantAvatar?: string | number;
}

const defaultConfig: Required<AdapterConfig> = {
  userId: 'user',
  userName: 'You',
  userAvatar: '',
  assistantId: 'assistant',
  assistantName: 'Assistant',
  assistantAvatar: '',
};

export function toGiftedMessage(
  message: Message,
  config: AdapterConfig = {}
): GiftedMessage {
  const cfg = { ...defaultConfig, ...config };

  const isUser = message.role === 'user';

  return {
    _id: message.id,
    text: message.content,
    createdAt: message.createdAt || new Date(),
    user: {
      _id: isUser ? cfg.userId : cfg.assistantId,
      name: isUser ? cfg.userName : cfg.assistantName,
      avatar: isUser ? cfg.userAvatar : cfg.assistantAvatar,
    },
  };
}

export function fromGiftedMessage(
  giftedMessage: GiftedMessage,
  config: AdapterConfig = {}
): Message {
  const cfg = { ...defaultConfig, ...config };
  const isUser = giftedMessage.user._id === cfg.userId;

  return {
    id: String(giftedMessage._id),
    role: isUser ? 'user' : 'assistant',
    content: giftedMessage.text,
    createdAt:
      giftedMessage.createdAt instanceof Date
        ? giftedMessage.createdAt
        : new Date(giftedMessage.createdAt),
  };
}

export function toGiftedMessages(
  messages: Message[],
  config: AdapterConfig = {}
): GiftedMessage[] {
  // Gifted Chat expects messages in reverse order (newest first)
  return [...messages]
    .reverse()
    .map((msg) => toGiftedMessage(msg, config));
}

export function fromGiftedMessages(
  giftedMessages: GiftedMessage[],
  config: AdapterConfig = {}
): Message[] {
  // Convert back to chronological order (oldest first)
  return [...giftedMessages]
    .reverse()
    .map((msg) => fromGiftedMessage(msg, config));
}
