/**
 * @mongrov/collab
 *
 * Collaboration adapter for real-time messaging.
 * Supports RocketChat and custom backends via adapter pattern.
 */

// Provider and hooks
export {
  CollabProvider,
  useCollab,
  usePresence,
  useTyping,
  useMessages,
} from './provider'
export type { CollabProviderProps } from './provider'

// State machine
export {
  collabMachine,
  getConnectionStatus,
  createMachineInput,
} from './machine'
export type {
  CollabMachineContext,
  CollabMachineEvent,
  CollabMachineInput,
} from './machine'

// Base adapter
export { BaseAdapter } from './adapters/base'

// Types
export type {
  // Connection
  CollabConnectionStatus,
  CollabConfig,
  CollabLogger,
  AdapterCredentials,

  // Adapter interface
  CollabAdapter,

  // Events
  CollabEvents,
  CollabEventName,
  CollabEventHandler,

  // Presence & Typing
  PresenceState,
  UserPresence,
  TypingUser,

  // Messages
  SendMessageParams,
  SendMessageResult,

  // Fetch options
  FetchMessagesOptions,
  FetchMessagesResult,
  FetchConversationsOptions,
  FetchConversationsResult,
  SearchOptions,
} from './types'
