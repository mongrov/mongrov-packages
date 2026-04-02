import React, { useCallback, useMemo, useState } from 'react';
import { View, useColorScheme, Text, TextInput, TouchableOpacity } from 'react-native';
import { GiftedChat, Bubble } from 'react-native-gifted-chat';
import { useAIChat } from '../use-ai-chat';
import type { ChatScreenProps } from '../types';
import { toGiftedMessages, type AdapterConfig, type GiftedMessage } from './message-adapter';
import { ChatEmptyState } from './ChatEmptyState';
import { QuickReplyBar } from './QuickReplyBar';
import { StreamingText } from './StreamingText';

// Theme colors for light/dark mode
const lightTheme = {
  background: '#ffffff',
  inputBackground: '#f5f5f5',
  inputBorder: '#e0e0e0',
  inputText: '#000000',
  placeholder: '#9e9e9e',
  sendButton: '#007AFF',
  sendButtonDisabled: '#c7c7cc',
  userBubble: '#007AFF',
  userText: '#ffffff',
  assistantBubble: '#e5e5ea',
  assistantText: '#000000',
};

const darkTheme = {
  background: '#000000',
  inputBackground: '#1c1c1e',
  inputBorder: '#38383a',
  inputText: '#ffffff',
  placeholder: '#8e8e93',
  sendButton: '#0a84ff',
  sendButtonDisabled: '#3a3a3c',
  userBubble: '#0a84ff',
  userText: '#ffffff',
  assistantBubble: '#2c2c2e',
  assistantText: '#ffffff',
};

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
  const colorScheme = useColorScheme();
  const theme = colorScheme === 'dark' ? darkTheme : lightTheme;
  const [inputText, setInputText] = useState('');

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

  const handleSendMessage = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;

    setInputText('');
    if (onSendOverride) {
      onSendOverride(text);
    } else {
      send(text);
    }
  }, [inputText, send, onSendOverride]);

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

  const renderBubble = useCallback(
    (props: any) => (
      <Bubble
        {...props}
        wrapperStyle={{
          left: {
            backgroundColor: theme.assistantBubble,
          },
          right: {
            backgroundColor: theme.userBubble,
          },
        }}
        textStyle={{
          left: {
            color: theme.assistantText,
          },
          right: {
            color: theme.userText,
          },
        }}
      />
    ),
    [theme]
  );

  const canSend = inputText.trim().length > 0 && !isStreaming;

  return (
    <View style={{ flex: 1, backgroundColor: theme.background }} testID={testID}>
      <View style={{ flex: 1 }} pointerEvents="box-none">
        <GiftedChat
          messages={giftedMessages}
          onSend={() => {}}
          user={{ _id: 'user', name: 'You' }}
          renderChatEmpty={renderChatEmpty}
          renderMessageText={renderMessageText}
          renderBubble={renderBubble}
          isTyping={isStreaming}
          inverted={true}
          renderInputToolbar={() => null}
        />
        {quickReplies.length > 0 && messages.length === 0 && (
          <QuickReplyBar
            replies={quickReplies}
            onSelect={handleQuickReply}
            testID={testID ? `${testID}-quick-replies` : undefined}
          />
        )}
      </View>

      {/* Custom Input Toolbar */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          paddingHorizontal: 8,
          paddingVertical: 8,
          backgroundColor: theme.inputBackground,
          borderTopWidth: 1,
          borderTopColor: theme.inputBorder,
        }}
      >
        <TextInput
          value={inputText}
          onChangeText={setInputText}
          placeholder={placeholder}
          placeholderTextColor={theme.placeholder}
          multiline
          style={{
            flex: 1,
            minHeight: 40,
            maxHeight: 120,
            backgroundColor: theme.background,
            borderRadius: 20,
            paddingHorizontal: 16,
            paddingTop: 10,
            paddingBottom: 10,
            fontSize: 16,
            color: theme.inputText,
            borderWidth: 1,
            borderColor: theme.inputBorder,
          }}
          onSubmitEditing={handleSendMessage}
          blurOnSubmit={false}
        />
        <TouchableOpacity
          onPress={handleSendMessage}
          disabled={!canSend}
          style={{
            marginLeft: 8,
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: canSend ? theme.sendButton : theme.sendButtonDisabled,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: '600' }}>↑</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
