# Changelog

All notable changes to `@mongrov/types` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
