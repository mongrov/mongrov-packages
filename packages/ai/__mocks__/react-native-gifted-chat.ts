import React from 'react';

export interface IMessage {
  _id: string | number;
  text: string;
  createdAt: Date | number;
  user: {
    _id: string | number;
    name?: string;
    avatar?: string | number;
  };
}

export interface GiftedChatProps<TMessage = IMessage> {
  messages?: TMessage[];
  onSend?: (messages: TMessage[]) => void;
  user?: { _id: string | number; name?: string; avatar?: string | number };
  textInputProps?: Record<string, unknown>;
  renderChatEmpty?: () => React.ReactNode;
  renderMessageText?: (props: { currentMessage?: TMessage }) => React.ReactNode;
  renderBubble?: (props: unknown) => React.ReactNode;
  renderComposer?: (props: unknown) => React.ReactNode;
  renderSend?: (props: unknown) => React.ReactNode;
  renderInputToolbar?: (props: unknown) => React.ReactNode;
  isTyping?: boolean;
  inverted?: boolean;
  alwaysShowSend?: boolean;
  [key: string]: unknown;
}

export const GiftedChat = jest.fn(({ messages, onSend, renderChatEmpty }: GiftedChatProps) => {
  return React.createElement(
    'div',
    { 'data-testid': 'gifted-chat' },
    messages && messages.length === 0 && renderChatEmpty ? renderChatEmpty() : null,
    messages?.map((m: IMessage) =>
      React.createElement('div', { key: m._id, 'data-testid': `message-${m._id}` }, m.text)
    )
  );
});

export const Bubble = jest.fn(() => null);
export const Composer = jest.fn(() => null);
export const Send = jest.fn(() => null);
export const InputToolbar = jest.fn(() => null);
