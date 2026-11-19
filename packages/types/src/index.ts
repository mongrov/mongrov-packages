/**
 * @mongrov/types
 *
 * Shared type definitions for @mongrov packages.
 * Interfaces only, with one exception: the device-event payload schemas
 * (`device-events`) are zod schemas and so carry runtime code.
 */

// Common utility types
export type {
  ConnectionStatus,
  FileUpload,
  Pagination,
  SearchOpts,
  Unsubscribe,
} from './common'

// Conversation types
export type {
  Conversation,
  ConversationType,
  CreateConversationConfig,
  GroupState,
  Member,
} from './conversation'

// Device types (v0.4.0)
export type {
  ConnectionState,
  Device,
  DeviceCapability,
  DeviceDiagnosticEvent,
  DeviceErrorCategory,
  DeviceReading,
  DeviceStatus,
  ErrorDetail,
  JsonValue,
  ReadingKind,
  ScanCandidate,
  SyncStatus,
} from './device'

// Message types
export type {
  Attachment,
  DeliveryStatus,
  Message,
  MessageContent,
  Reaction,
} from './message'

// Participant types
export type {
  MemberRole,
  Participant,
  ParticipantType,
  PresenceStatus,
} from './participant'

// Multi-brand tenancy (v0.5.0 — Sprint 3 precondition)
export type {
  AnalyticsDevice,
  Brand,
  Family,
  User,
} from './tenancy'
