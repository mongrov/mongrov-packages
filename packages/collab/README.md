# @mongrov/collab

Collaboration adapter for real-time messaging in `@mongrov` apps.

## Features

- **Adapter Pattern** — Swap between backends (RocketChat, custom WebSocket, etc.)
- **XState v5 State Machine** — Robust connection management with auto-reconnect
- **React Integration** — Provider and hooks for easy component access
- **Real-time Updates** — Messages, typing indicators, presence

## Installation

```bash
pnpm add @mongrov/collab @mongrov/types xstate
```

## Quick Start

### 1. Create an Adapter

Extend `BaseAdapter` or `RocketChatAdapter` with your existing client:

```typescript
import { BaseAdapter } from '@mongrov/collab'
import type { AdapterCredentials, SendMessageParams } from '@mongrov/collab'

class MyAdapter extends BaseAdapter {
  readonly id = 'my-adapter'

  private client: MyExistingClient

  constructor(client: MyExistingClient) {
    super()
    this.client = client
  }

  async connect(credentials: AdapterCredentials) {
    await this.client.connect(credentials.token)
    this.setStatus('connected')
    this.emit('connection:connected', undefined)
  }

  async disconnect() {
    await this.client.disconnect()
    this.setStatus('disconnected')
    this.emit('connection:disconnected', {})
  }

  async sendMessage(params: SendMessageParams) {
    const result = await this.client.send(params)
    return { messageId: result.id, message: result }
  }

  // ... implement other methods
}
```

### 2. Set Up Provider

```tsx
import { CollabProvider } from '@mongrov/collab'

function App() {
  const adapter = useMemo(() => new MyAdapter(existingClient), [])

  return (
    <CollabProvider config={{ adapter, autoConnect: false }}>
      <ChatApp />
    </CollabProvider>
  )
}
```

### 3. Use Hooks

```tsx
import { useCollab, useMessages, useTyping } from '@mongrov/collab'

function ChatScreen({ conversationId }) {
  const { status, isConnected, connect, sendMessage } = useCollab()
  const { messages, isLoading, loadMore } = useMessages(conversationId)
  const { typingUsers, sendTyping } = useTyping(conversationId)

  // Connect on mount
  useEffect(() => {
    if (!isConnected) {
      connect({ serverUrl: 'wss://chat.example.com', token: authToken })
    }
  }, [])

  const handleSend = async (text: string) => {
    await sendMessage({
      conversationId,
      content: { type: 'text', text },
    })
  }

  return (
    <View>
      <MessageList messages={messages} onEndReached={loadMore} />
      {typingUsers.length > 0 && <TypingIndicator users={typingUsers} />}
      <MessageInput
        onSend={handleSend}
        onTyping={(isTyping) => sendTyping(isTyping)}
      />
    </View>
  )
}
```

## API Reference

### CollabProvider

```tsx
<CollabProvider config={config}>
  {children}
</CollabProvider>
```

Config options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `adapter` | `CollabAdapter` | required | The adapter instance |
| `autoConnect` | `boolean` | `false` | Connect automatically on mount |
| `reconnect.enabled` | `boolean` | `true` | Enable auto-reconnect |
| `reconnect.maxAttempts` | `number` | `10` | Max reconnection attempts |
| `reconnect.baseDelay` | `number` | `1000` | Base delay (ms) |
| `reconnect.maxDelay` | `number` | `30000` | Max delay (ms) |

### useCollab()

```typescript
const {
  status,           // 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'
  isConnected,      // boolean
  isConnecting,     // boolean
  error,            // Error | null
  connect,          // (credentials) => void
  disconnect,       // () => void
  retry,            // () => void
  sendMessage,      // (params) => Promise<SendMessageResult>
  sendTyping,       // (conversationId, isTyping) => Promise<void>
  setPresence,      // (status) => Promise<void>
  addReaction,      // (messageId, emoji) => Promise<void>
  removeReaction,   // (messageId, emoji) => Promise<void>
  editMessage,      // (messageId, content) => Promise<void>
  deleteMessage,    // (messageId) => Promise<void>
  markAsRead,       // (conversationId, messageId?) => Promise<void>
  on,               // (event, handler) => Unsubscribe
  adapter,          // CollabAdapter
} = useCollab()
```

### useMessages(conversationId)

```typescript
const {
  messages,    // Message[]
  isLoading,   // boolean
  error,       // Error | null
  hasMore,     // boolean
  loadMore,    // () => Promise<void>
  refresh,     // () => Promise<void>
} = useMessages(conversationId)
```

### useTyping(conversationId)

```typescript
const {
  typingUsers,  // TypingUser[]
  sendTyping,   // (isTyping: boolean) => void
} = useTyping(conversationId)
```

### usePresence(userIds)

```typescript
const {
  presence,   // Map<string, UserPresence>
  isLoading,  // boolean
} = usePresence(['user-1', 'user-2'])
```

## Creating Custom Adapters

Extend `BaseAdapter` and implement all abstract methods:

```typescript
import { BaseAdapter } from '@mongrov/collab'

class CustomAdapter extends BaseAdapter {
  readonly id = 'custom'

  // Required methods:
  async connect(credentials) { /* ... */ }
  async disconnect() { /* ... */ }
  async sendMessage(params) { /* ... */ }
  async sendTyping(conversationId, isTyping) { /* ... */ }
  async setPresence(status) { /* ... */ }
  async addReaction(messageId, emoji) { /* ... */ }
  async removeReaction(messageId, emoji) { /* ... */ }
  async editMessage(messageId, content) { /* ... */ }
  async deleteMessage(messageId) { /* ... */ }
  async markAsRead(conversationId, messageId?) { /* ... */ }
  async subscribeToConversation(conversationId) { /* ... */ }
  async subscribeToPresence(userIds) { /* ... */ }
  async fetchMessages(conversationId, options?) { /* ... */ }
  async fetchConversations(options?) { /* ... */ }
  async getUser(userId) { /* ... */ }
  async searchMessages(query, options?) { /* ... */ }
}
```

Use `this.setStatus()` to update connection status and `this.emit()` to dispatch events.

## License

MIT
