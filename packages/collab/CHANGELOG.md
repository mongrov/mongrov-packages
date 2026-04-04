# Changelog

All notable changes to `@mongrov/collab` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-03

### Added

- Comprehensive test coverage (72 tests)
- Integration tests for collab + db sync scenarios
- MockAdapter for testing custom integrations
- Additional event types and handlers

### Changed

- Improved connection state machine reliability
- Enhanced error recovery in reconnection logic
- Better TypeScript type exports
- Improved documentation

### Fixed

- Edge cases in typing indicator debouncing
- Memory leaks in presence subscriptions

## [0.1.0] - 2024-01-15

### Added

- Initial release of `@mongrov/collab`
- **Adapter Pattern**: Swappable backends via `CollabAdapter` interface
- **BaseAdapter**: Abstract base class with event handling for custom adapters
- **RocketChatAdapter**: Stub adapter for RocketChat integration (to be extended by app)
- **XState v5 Connection Machine**: Robust state management with:
  - Automatic reconnection with exponential backoff
  - Configurable max attempts, base delay, and max delay
  - Connection states: disconnected, connecting, connected, reconnecting, error
- **React Integration**:
  - `CollabProvider`: Context provider for collaboration state
  - `useCollab()`: Hook for connection control and message operations
  - `useMessages(conversationId)`: Hook for real-time message updates
  - `useTyping(conversationId)`: Hook for typing indicators
  - `usePresence(userIds)`: Hook for presence tracking
- **Event System**: Typed events for connection, messages, typing, presence
- **TypeScript**: Full type definitions for all public APIs

### Dependencies

- `xstate` ^5.18.0
- `@mongrov/types` workspace dependency
- Peer dependency: `react` >=18
