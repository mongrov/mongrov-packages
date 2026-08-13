/**
 * @mongrov/types
 *
 * Shared type definitions for @mongrov packages.
 * Zero runtime — interfaces only.
 */

// Cross-package data-plane contracts (v0.5.0 — Sprint 3 precondition).
// Implementations live in @mongrov/analytics + @mongrov/data-access; these
// are the seams, so neither package needs a runtime dep on the other.
export type {
  Unsubscribe as AnalyticsUnsubscribe,
  EventBus,
  FirmwareActivityRow,
  FirmwareBatteryRow,
  FirmwareExport,
  FirmwareHRRow,
  FirmwareHRVRow,
  FirmwareMonitoringWindow,
  FirmwareRingConfig,
  FirmwareSleepRow,
  FirmwareSpO2Row,
  FirmwareTempRow,
  FirmwareTimestamp,
  FlushResult,
  MapperContext,
  SensorBatch,
  SensorSink,
} from './analytics-contracts'

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

// KVStore key namespace registry (v0.5.x — Sprint 5 T-42). Value exports,
// so imported from the `./kv-keys` subpath by runtime consumers; the types
// are re-exported here for convenience.
export type { KvKey, KvKeyEntry } from './kv-keys'

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
