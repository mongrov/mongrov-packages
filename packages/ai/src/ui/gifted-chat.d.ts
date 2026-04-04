declare module 'react-native-gifted-chat' {
  import type { ComponentType, ReactNode } from 'react';
  import type { StyleProp, ViewStyle, TextStyle } from 'react-native';

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

  export interface BubbleProps<TMessage = IMessage> {
    currentMessage?: TMessage;
    nextMessage?: TMessage;
    previousMessage?: TMessage;
    position: 'left' | 'right';
    wrapperStyle?: {
      left?: StyleProp<ViewStyle>;
      right?: StyleProp<ViewStyle>;
    };
    textStyle?: {
      left?: StyleProp<TextStyle>;
      right?: StyleProp<TextStyle>;
    };
    renderMessageText?: (props: { currentMessage?: TMessage }) => ReactNode;
    [key: string]: unknown;
  }

  export interface ComposerProps {
    text?: string;
    placeholder?: string;
    onTextChanged?: (text: string) => void;
    [key: string]: unknown;
  }

  export interface SendProps<TMessage = IMessage> {
    text?: string;
    onSend?: (messages: Partial<TMessage>[], shouldResetInputToolbar: boolean) => void;
    [key: string]: unknown;
  }

  export interface InputToolbarProps {
    renderComposer?: (props: ComposerProps) => ReactNode;
    renderSend?: (props: SendProps) => ReactNode;
    [key: string]: unknown;
  }

  export interface GiftedChatProps<TMessage = IMessage> {
    messages?: TMessage[];
    onSend?: (messages: TMessage[]) => void;
    user?: { _id: string | number; name?: string; avatar?: string | number };
    textInputProps?: Record<string, unknown>;
    renderChatEmpty?: () => ReactNode;
    renderMessageText?: (props: { currentMessage?: TMessage }) => ReactNode;
    renderBubble?: (props: BubbleProps<TMessage>) => ReactNode;
    renderComposer?: (props: ComposerProps) => ReactNode;
    renderSend?: (props: SendProps<TMessage>) => ReactNode;
    renderInputToolbar?: (props: InputToolbarProps) => ReactNode;
    isTyping?: boolean;
    inverted?: boolean;
    alwaysShowSend?: boolean;
    [key: string]: unknown;
  }

  export const GiftedChat: ComponentType<GiftedChatProps>;
  export const Bubble: ComponentType<BubbleProps>;
  export const Composer: ComponentType<ComposerProps>;
  export const Send: ComponentType<SendProps>;
  export const InputToolbar: ComponentType<InputToolbarProps>;
}
