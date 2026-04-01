declare module 'react-native-gifted-chat' {
  import type { ComponentType, ReactNode } from 'react';

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
    renderChatEmpty?: () => ReactNode;
    renderMessageText?: (props: { currentMessage?: TMessage }) => ReactNode;
    renderBubble?: (props: any) => ReactNode;
    renderComposer?: (props: any) => ReactNode;
    renderSend?: (props: any) => ReactNode;
    renderInputToolbar?: (props: any) => ReactNode;
    isTyping?: boolean;
    inverted?: boolean;
    alwaysShowSend?: boolean;
    [key: string]: unknown;
  }

  export const GiftedChat: ComponentType<GiftedChatProps<any>>;
  export const Bubble: ComponentType<any>;
  export const Composer: ComponentType<any>;
  export const Send: ComponentType<any>;
  export const InputToolbar: ComponentType<any>;
}
