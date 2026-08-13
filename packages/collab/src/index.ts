/**
 * @mongrov/collab
 *
 * Collaboration adapter for real-time messaging.
 * Supports RocketChat and custom backends via adapter pattern.
 */

// Base adapter
export { BaseAdapter } from './adapters/base'
// State machine
export {
  collabMachine,
  createMachineInput,
  getConnectionStatus,
} from './machine'

export type {
  CollabMachineContext,
  CollabMachineEvent,
  CollabMachineInput,
} from './machine'
// Provider and hooks
export {
  CollabProvider,
  useCollab,
  useMessages,
  usePresence,
  useTyping,
} from './provider'

export type { CollabProviderProps } from './provider'

// Types
export type {
  AdapterCredentials,
  // Adapter interface
  CollabAdapter,
  CollabConfig,
  // Connection
  CollabConnectionStatus,

  CollabEventHandler,

  CollabEventName,
  // Events
  CollabEvents,
  CollabLogger,

  FetchConversationsOptions,
  FetchConversationsResult,
  // Fetch options
  FetchMessagesOptions,

  FetchMessagesResult,
  // Presence & Typing
  PresenceState,

  SearchOptions,
  // Messages
  SendMessageParams,
  SendMessageResult,
  TypingUser,
  UserPresence,
} from './types'
