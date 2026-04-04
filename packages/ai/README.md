# @mongrov/ai

AI chat and completion hooks for React Native / Expo applications. Built with XState for state management and compatible with the AI SDK.

## Installation

```bash
npm install @mongrov/ai
# or
pnpm add @mongrov/ai
```

### Peer Dependencies

```bash
npm install react ai xstate @xstate/react
```

### Optional Dependencies

For the pre-built chat UI:
```bash
npm install react-native-gifted-chat uniwind
```

## Features

- **XState-powered**: Robust state management for chat and completion flows
- **AI SDK compatible**: Works with Vercel AI SDK providers
- **Streaming support**: Real-time streaming text responses
- **Type-safe**: Full TypeScript support
- **UI components**: Optional pre-built chat components

## Quick Start

### 1. Set up the Provider

```tsx
import { AIProvider, createAIClient } from '@mongrov/ai';

const aiClient = createAIClient({
  baseUrl: 'https://your-ai-api.com',
  apiKey: 'your-api-key',
  model: 'gpt-4',
});

function App() {
  return (
    <AIProvider client={aiClient}>
      <ChatScreen />
    </AIProvider>
  );
}
```

### 2. Use the Chat Hook

```tsx
import { useAIChat } from '@mongrov/ai';

function ChatScreen() {
  const {
    messages,
    sendMessage,
    isLoading,
    error,
    stop,
  } = useAIChat();

  const handleSend = (text: string) => {
    sendMessage({ content: text });
  };

  return (
    <View>
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      <ChatInput onSend={handleSend} disabled={isLoading} />
    </View>
  );
}
```

### 3. Use the Completion Hook

For single completions (non-chat):

```tsx
import { useAICompletion } from '@mongrov/ai';

function CompletionExample() {
  const {
    completion,
    complete,
    isLoading,
    error,
  } = useAICompletion();

  const handleGenerate = async () => {
    await complete('Write a haiku about coding');
  };

  return (
    <View>
      <Button onPress={handleGenerate} title="Generate" />
      {isLoading && <ActivityIndicator />}
      {completion && <Text>{completion}</Text>}
    </View>
  );
}
```

## API Reference

### AIProvider

The context provider for AI functionality.

```tsx
import { AIProvider } from '@mongrov/ai';

<AIProvider
  client={aiClient}           // Required: AI client instance
  config={{                   // Optional: Additional config
    systemPrompt: 'You are a helpful assistant',
    maxTokens: 1000,
  }}
>
  {children}
</AIProvider>
```

### createAIClient

Creates an AI client instance.

```tsx
import { createAIClient } from '@mongrov/ai';

const client = createAIClient({
  baseUrl: 'https://api.openai.com/v1',  // API endpoint
  apiKey: 'sk-...',                       // API key
  model: 'gpt-4',                         // Model to use
  headers: {},                            // Optional: Additional headers
});
```

### useAIChat

Hook for managing chat conversations.

```tsx
const {
  // State
  messages,      // Message[] - conversation history
  isLoading,     // boolean - whether a request is in progress
  error,         // Error | null - last error

  // Actions
  sendMessage,   // (params: { content: string }) => void
  stop,          // () => void - stop streaming
  reset,         // () => void - clear conversation

  // Metadata
  status,        // 'idle' | 'loading' | 'streaming' | 'error'
} = useAIChat({
  initialMessages: [],        // Optional: Starting messages
  onError: (error) => {},     // Optional: Error callback
  onFinish: (message) => {},  // Optional: Completion callback
});
```

### useAICompletion

Hook for single completions.

```tsx
const {
  // State
  completion,    // string | null - generated text
  isLoading,     // boolean
  error,         // Error | null

  // Actions
  complete,      // (prompt: string) => Promise<void>
  stop,          // () => void
  reset,         // () => void
} = useAICompletion({
  onError: (error) => {},
  onFinish: (result) => {},
});
```

### useAIContext

Access the AI context directly.

```tsx
import { useAIContext, useAIClient, useAIConfig } from '@mongrov/ai';

// Get the full context
const context = useAIContext();

// Get just the client
const client = useAIClient();

// Get just the config
const config = useAIConfig();
```

## UI Components

Optional pre-built UI components for chat interfaces.

### StreamingText

Displays text with a streaming cursor effect.

```tsx
import { StreamingText } from '@mongrov/ai/ui';

<StreamingText
  text={message.content}
  isStreaming={isGenerating}
  cursorChar="|"
/>
```

### QuickReplyBar

Displays quick reply suggestions.

```tsx
import { QuickReplyBar } from '@mongrov/ai/ui';

<QuickReplyBar
  replies={['Tell me more', 'What else?', 'Thanks!']}
  onSelect={(reply) => sendMessage({ content: reply })}
/>
```

### ChatEmptyState

Empty state for chat screens.

```tsx
import { ChatEmptyState } from '@mongrov/ai/ui';

<ChatEmptyState
  title="Start a conversation"
  subtitle="Send a message to begin chatting"
/>
```

### Message Adapter

Convert between AI SDK messages and Gifted Chat format:

```tsx
import { toGiftedChatMessages, fromGiftedChatMessage } from '@mongrov/ai/ui';

// AI SDK -> Gifted Chat
const giftedMessages = toGiftedChatMessages(aiMessages, currentUserId);

// Gifted Chat -> AI SDK
const aiMessage = fromGiftedChatMessage(giftedMessage);
```

## Types

```typescript
interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt?: Date;
}

interface AIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

interface UseAIChatReturn {
  messages: Message[];
  isLoading: boolean;
  error: Error | null;
  status: 'idle' | 'loading' | 'streaming' | 'error';
  sendMessage: (params: { content: string }) => void;
  stop: () => void;
  reset: () => void;
}
```

## Examples

### With Gifted Chat

```tsx
import { GiftedChat } from 'react-native-gifted-chat';
import { useAIChat } from '@mongrov/ai';
import { toGiftedChatMessages, fromGiftedChatMessage } from '@mongrov/ai/ui';

function ChatScreen() {
  const { messages, sendMessage, isLoading } = useAIChat();
  const currentUserId = 'user-1';

  const giftedMessages = toGiftedChatMessages(messages, currentUserId);

  const onSend = (newMessages: IMessage[]) => {
    const message = fromGiftedChatMessage(newMessages[0]);
    sendMessage({ content: message.content });
  };

  return (
    <GiftedChat
      messages={giftedMessages}
      onSend={onSend}
      user={{ _id: currentUserId }}
      isTyping={isLoading}
    />
  );
}
```

### Error Handling

```tsx
import { useAIChat } from '@mongrov/ai';

function ChatWithErrorHandling() {
  const { messages, sendMessage, error, reset } = useAIChat({
    onError: (err) => {
      console.error('AI Error:', err);
      // Show toast, log to analytics, etc.
    },
  });

  if (error) {
    return (
      <ErrorState
        message={error.message}
        onRetry={() => {
          reset();
          // Retry last message
        }}
      />
    );
  }

  // ... rest of component
}
```

## License

MIT
