# Changelog

All notable changes to `@mongrov/types` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-04-06

### Added

- **Message v0.3.0 fields** (based on 5-platform schema validation: RC, Mattermost, Matrix, WhatsApp, Messenger):
  - `editedBy?: Participant` — Who edited the message
  - `updatedAt?: string` — Sync high-water mark (ISO 8601)
  - `systemType?: string` — System events like `'user_joined'`, `'room_renamed'`
- **MessageContent v0.3.0 additions**:
  - Added `'location'` and `'sticker'` to content type union
  - `latitude?: number` — For location content
  - `longitude?: number` — For location content
- **Conversation v0.3.0 fields**:
  - `topic?: string` — Room topic
  - `description?: string` — Room description
  - `metadata?: Record<string, unknown>` — Backend-specific fields bag

### Changed

- Updated type-level compile tests for all v0.3.0 additions

## [0.2.0] - 2026-04-03

### Added

- `ConnectionStatus` type for tracking connection states
- `FileUpload` type for file upload handling
- `PaginationParams` and `PaginatedResult` for pagination support
- `CreateConversationConfig` for conversation creation
- `Member` type for conversation membership

### Changed

- Improved type documentation with JSDoc comments
- Standardized export patterns across all types

## [0.1.0] - 2024-01-15

### Added

- Initial release of `@mongrov/types`
- **Message Types**:
  - `Message`: Core message type with content, sender, reactions, delivery status
  - `MessageContent`: Text, image, audio, video, file content types
  - `Reaction`: Emoji reactions with user tracking
  - `DeliveryStatus`: Message delivery states (sending, sent, delivered, read, failed)
- **Conversation Types**:
  - `Conversation`: Chat room/channel with participants and metadata
  - `ConversationType`: Direct, group, channel variants
  - `ConversationSettings`: Mute, pin, archive settings
- **Participant Types**:
  - `Participant`: User/bot participant with role and type
  - `ParticipantRole`: Owner, admin, member roles
  - `ParticipantType`: Human, bot, system types
- **Utility Types**:
  - `Unsubscribe`: Standard unsubscribe function type
  - `Timestamp`: ISO 8601 timestamp string alias
