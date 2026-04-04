/**
 * @mongrov/types
 *
 * Shared type definitions for @mongrov packages.
 * Zero runtime — interfaces only.
 */

// Message types
export type {
  Message,
  MessageContent,
  Attachment,
  Reaction,
  DeliveryStatus,
} from './message'

// Conversation types
export type {
  Conversation,
  Member,
  CreateConversationConfig,
  ConversationType,
  GroupState,
} from './conversation'

// Participant types
export type {
  Participant,
  ParticipantType,
  MemberRole,
  PresenceStatus,
} from './participant'

// Common utility types
export type {
  Pagination,
  Unsubscribe,
  ConnectionStatus,
  FileUpload,
  SearchOpts,
} from './common'
