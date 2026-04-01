import React, { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { GiftedChat } from 'react-native-gifted-chat';
import { useAIChat } from '../use-ai-chat';
import type { ChatScreenProps } from '../types';
import { toGiftedMessages, type AdapterConfig, type GiftedMessage } from './message-adapter';
import { ChatEmptyState } from './ChatEmptyState';
import { QuickReplyBar } from './QuickReplyBar';
import { StreamingText } from './StreamingText';

export function ChatScreen({
  placeholder = 'Type a message...',
  emptyTitle,
  emptySubtitle,
  quickReplies = [],
  assistantName = 'Assistant',
  assistantAvatar,
  onSend: onSendOverride,
  testID,
}: ChatScreenProps) {
  const { messages, send, isStreaming } = useAIChat();

  const adapterConfig: AdapterConfig = useMemo(
    () => ({
      assistantName,
      assistantAvatar,
    }),
    [assistantName, assistantAvatar]
  );

  const giftedMessages = useMemo(
    () => toGiftedMessages(messages, adapterConfig),
    [messages, adapterConfig]
  );

  const handleSend = useCallback(
    (newMessages: GiftedMessage[] = []) => {
      const text = newMessages[0]?.text;
      if (text) {
        if (onSendOverride) {
          onSendOverride(text);
        } else {
          send(text);
        }
      }
    },
    [send, onSendOverride]
  );

  const handleQuickReply = useCallback(
    (reply: string) => {
      if (onSendOverride) {
        onSendOverride(reply);
      } else {
        send(reply);
      }
    },
    [send, onSendOverride]
  );

  const renderChatEmpty = useCallback(
    () => (
      <ChatEmptyState
        title={emptyTitle}
        subtitle={emptySubtitle}
        testID={testID ? `${testID}-empty` : undefined}
      />
    ),
    [emptyTitle, emptySubtitle, testID]
  );

  const renderMessageText = useCallback(
    (props: { currentMessage?: GiftedMessage }) => {
      const { currentMessage } = props;
      const isAssistant = currentMessage?.user?._id === 'assistant';
      const isLastMessage =
        giftedMessages.length > 0 &&
        giftedMessages[0]?._id === currentMessage?._id;
      const showStreaming = isAssistant && isLastMessage && isStreaming;

      return (
        <StreamingText
          text={currentMessage?.text || ''}
          isStreaming={showStreaming}
          className="px-3 py-2"
          testID={testID ? `${testID}-message-${currentMessage?._id}` : undefined}
        />
      );
    },
    [giftedMessages, isStreaming, testID]
  );

  const textInputProps = useMemo(
    () => ({
      placeholder,
    }),
    [placeholder]
  );

  return (
    <View className="flex-1 bg-background" testID={testID}>
      <GiftedChat
        messages={giftedMessages}
        onSend={handleSend}
        user={{ _id: 'user', name: 'You' }}
        textInputProps={textInputProps}
        renderChatEmpty={renderChatEmpty}
        renderMessageText={renderMessageText}
        isTyping={isStreaming}
        inverted={true}
        alwaysShowSend
      />
      {quickReplies.length > 0 && messages.length === 0 && (
        <QuickReplyBar
          replies={quickReplies}
          onSelect={handleQuickReply}
          testID={testID ? `${testID}-quick-replies` : undefined}
        />
      )}
    </View>
  );
}
