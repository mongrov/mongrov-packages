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

// Multi-brand tenancy (v0.5.0 — Sprint 3 precondition)
export type {
  Brand,
  Family,
  User,
  AnalyticsDevice,
} from './tenancy'

// Cross-package data-plane contracts (v0.5.0 — Sprint 3 precondition).
// Implementations live in @mongrov/analytics + @mongrov/data-access; these
// are the seams, so neither package needs a runtime dep on the other.
export type {
  Unsubscribe as AnalyticsUnsubscribe,
  FirmwareExport,
  FirmwareTimestamp,
  FirmwareHRRow,
  FirmwareHRVRow,
  FirmwareSpO2Row,
  FirmwareTempRow,
  FirmwareActivityRow,
  FirmwareSleepRow,
  FirmwareBatteryRow,
  FirmwareRingConfig,
  FirmwareMonitoringWindow,
  MapperContext,
  SensorBatch,
  SensorSink,
  FlushResult,
  EventBus,
} from './analytics-contracts'

// KVStore key namespace registry (v0.5.x — Sprint 5 T-42). Value exports,
// so imported from the `./kv-keys` subpath by runtime consumers; the types
// are re-exported here for convenience.
export type { KvKey, KvKeyEntry } from './kv-keys'

// Device types (v0.4.0)
export type {
  JsonValue,
  ScanCandidate,
  ConnectionState,
  DeviceErrorCategory,
  ErrorDetail,
  Device,
  DeviceStatus,
  DeviceCapability,
  ReadingKind,
  DeviceReading,
  SyncStatus,
  DeviceDiagnosticEvent,
} from './device'
