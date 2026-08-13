import type { BubbleProps } from 'react-native-gifted-chat'
import type { ChatScreenProps, ChatTheme } from '../types'
import type { AdapterConfig, GiftedMessage } from './message-adapter'
import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { Text, TextInput, TouchableOpacity, useColorScheme as useSystemColorScheme, View } from 'react-native'
import { Bubble, GiftedChat } from 'react-native-gifted-chat'
import { useAIChat } from '../use-ai-chat'
import { ChatEmptyState } from './ChatEmptyState'
import { toGiftedMessages } from './message-adapter'
import { QuickReplyBar } from './QuickReplyBar'
import { StreamingText } from './StreamingText'

/**
 * The few colours that cannot be classNames.
 *
 * Everything this component renders itself is styled with uniwind classNames
 * resolved from the consumer's semantic tokens, so it follows the app's theme
 * and brand with no configuration. Two things resist that:
 *
 *   - `placeholderTextColor` is a React Native prop taking a raw colour
 *   - gifted-chat's `Bubble` takes `wrapperStyle` / `textStyle` objects
 *
 * The `theme` prop covers exactly those. Defaults track the semantic tokens
 * (`--color-muted`, `--color-muted-foreground`, `--color-primary`) so an app
 * that passes nothing still looks native rather than iOS-generic.
 */
const lightBubbles: ChatTheme = {
  placeholder: '#737373',
  userBubble: '#FF6C00',
  userText: '#FFFFFF',
  assistantBubble: '#f5f5f5',
  assistantText: '#0a0a0a',
}

const darkBubbles: ChatTheme = {
  placeholder: '#a3a3a3',
  userBubble: '#FF6C00',
  userText: '#FFFFFF',
  assistantBubble: '#262626',
  assistantText: '#fafafa',
}

export function ChatScreen({
  placeholder = 'Type a message...',
  emptyTitle,
  emptySubtitle,
  quickReplies = [],
  assistantName = 'Assistant',
  assistantAvatar,
  onSend: onSendOverride,
  theme: themeOverride,
  testID,
}: ChatScreenProps) {
  const { messages, send, isStreaming, error } = useAIChat()
  // Scheme is still read for the raw-colour values above; everything else is
  // a className, so the consumer's `dark` class drives it.
  const isDark = useSystemColorScheme() === 'dark'
  const theme = useMemo(
    () => ({ ...(isDark ? darkBubbles : lightBubbles), ...themeOverride }),
    [isDark, themeOverride],
  )
  const [inputText, setInputText] = useState('')

  const adapterConfig: AdapterConfig = useMemo(
    () => ({
      assistantName,
      assistantAvatar,
    }),
    [assistantName, assistantAvatar],
  )

  const giftedMessages = useMemo(
    () => toGiftedMessages(messages, adapterConfig),
    [messages, adapterConfig],
  )

  const handleSendMessage = useCallback(() => {
    const text = inputText.trim()
    if (!text)
      return

    setInputText('')
    if (onSendOverride) {
      onSendOverride(text)
    }
    else {
      send(text)
    }
  }, [inputText, send, onSendOverride])

  const handleQuickReply = useCallback(
    (reply: string) => {
      if (onSendOverride) {
        onSendOverride(reply)
      }
      else {
        send(reply)
      }
    },
    [send, onSendOverride],
  )

  const renderChatEmpty = useCallback(
    () => (
      <ChatEmptyState
        title={emptyTitle}
        subtitle={emptySubtitle}
        testID={testID ? `${testID}-empty` : undefined}
      />
    ),
    [emptyTitle, emptySubtitle, testID],
  )

  const renderMessageText = useCallback(
    (props: { currentMessage?: GiftedMessage }) => {
      const { currentMessage } = props
      const isAssistant = currentMessage?.user?._id === 'assistant'
      const isLastMessage
        = giftedMessages.length > 0
          && giftedMessages[0]?._id === currentMessage?._id
      const showStreaming = isAssistant && isLastMessage && isStreaming

      return (
        <StreamingText
          text={currentMessage?.text || ''}
          isStreaming={showStreaming}
          className="px-3 py-2"
          testID={testID ? `${testID}-message-${currentMessage?._id}` : undefined}
        />
      )
    },
    [giftedMessages, isStreaming, testID],
  )

  const renderBubble = useCallback(
    (props: BubbleProps<GiftedMessage>) => (
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
    [theme],
  )

  const canSend = inputText.trim().length > 0 && !isStreaming

  /**
   * gifted-chat 3.x removed the `isTyping` prop in favour of
   * `renderTypingIndicator`, and does not export its own TypingIndicator, so
   * this is ours. Returning null while idle is what suppresses it — there is
   * no boolean to toggle any more.
   */
  const renderTypingIndicator = useCallback(() => {
    if (!isStreaming)
      return null
    return (
      <View
        className="mb-2 ml-3 self-start rounded-2xl bg-muted px-3 py-2"
        testID={testID ? `${testID}-typing` : undefined}
      >
        <Text className="text-sm text-foreground">…</Text>
      </View>
    )
  }, [isStreaming, theme, testID])

  return (
    <View className="flex-1 bg-background" testID={testID}>
      <View style={{ flex: 1 }} pointerEvents="box-none">
        <GiftedChat
          messages={giftedMessages}
          onSend={() => {}}
          user={{ _id: 'user', name: 'You' }}
          renderChatEmpty={renderChatEmpty}
          renderMessageText={renderMessageText}
          renderBubble={renderBubble}
          renderTypingIndicator={renderTypingIndicator}
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

      {/*
        A failed request used to be invisible: the machine catches the error
        into context, but this screen never read it, so a bad key, a network
        failure or a rejected model all looked identical to "nothing
        happened". Rendered above the input, where the user is looking.
      */}
      {error && (
        <View
          className="bg-muted px-4 py-2.5"
          testID={testID ? `${testID}-error` : undefined}
        >
          <Text className="text-[13px] text-destructive">
            {error.message}
          </Text>
        </View>
      )}

      {/* Custom Input Toolbar */}
      <View
        className="flex-row items-end border-t border-border bg-muted px-2 py-2"
      >
        <TextInput
          value={inputText}
          onChangeText={setInputText}
          placeholder={placeholder}
          placeholderTextColor={theme.placeholder}
          multiline
          className="max-h-[120px] min-h-[40px] flex-1 rounded-[20px] border border-border bg-background px-4 py-2.5 text-base text-foreground"
          onSubmitEditing={handleSendMessage}
          blurOnSubmit={false}
        />
        <TouchableOpacity
          onPress={handleSendMessage}
          disabled={!canSend}
          className={`ml-2 size-10 items-center justify-center rounded-[20px] ${
            canSend ? 'bg-primary' : 'bg-muted'
          }`}
        >
          <Text className="text-lg font-semibold text-primary-foreground">↑</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}
