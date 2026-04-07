# @mongrov/types

Shared type definitions for `@mongrov` packages. Zero runtime — interfaces only.

## Installation

```bash
pnpm add @mongrov/types
```

## Usage

```typescript
import type {
  Message,
  Conversation,
  Participant,
  Pagination,
} from '@mongrov/types'

// Create a message
const message: Message = {
  id: 'msg-1',
  conversationId: 'conv-1',
  sender: { id: 'user-1', name: 'John', type: 'human' },
  content: { type: 'text', text: 'Hello!' },
  deliveryStatus: 'sent',
  createdAt: new Date().toISOString(),
}
```

## Types

### Message Types

- `Message` — Full message with sender, content, attachments, reactions
  - v0.3.0: Added `editedBy`, `updatedAt`, `systemType` fields
- `MessageContent` — Content payload (text, image, audio, video, file, voice, location, sticker)
  - v0.3.0: Added `location` and `sticker` types with `latitude`/`longitude` support
- `Attachment` — File attachment with metadata
- `Reaction` — Emoji reaction with user list
- `DeliveryStatus` — `'sending' | 'sent' | 'delivered' | 'read' | 'failed'`

### Conversation Types

- `Conversation` — Chat room with members, state, unread count
  - v0.3.0: Added `topic`, `description`, `metadata` fields
- `Member` — Participant with role in a conversation
- `CreateConversationConfig` — Config for creating new conversations
- `ConversationType` — `'1:1' | 'group' | 'channel'`
- `GroupState` — `'invited' | 'open' | 'read-only' | 'closed' | 'archived'`

### Participant Types

- `Participant` — User or bot identity
- `ParticipantType` — `'human' | 'ai' | 'bot' | 'system'`
- `MemberRole` — `'owner' | 'admin' | 'moderator' | 'member'`
- `PresenceStatus` — `'online' | 'away' | 'busy' | 'offline'`

### Common Types

- `Pagination` — Cursor-based pagination options
- `Unsubscribe` — Cleanup function type `() => void`
- `ConnectionStatus` — `'connected' | 'connecting' | 'disconnected' | 'reconnecting'`
- `FileUpload` — File metadata for uploads
- `SearchOpts` — Search query options

## Design

This package provides shared interfaces used by both `@mongrov/ai` and `@mongrov/collab`. By centralizing types here:

- AI and collab packages don't depend on each other
- Message format is consistent across the platform
- `@mongrov/core` stays focused on logging (one package, one purpose)

## License

MIT
