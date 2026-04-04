# Changelog

All notable changes to `@mongrov/ai` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-03

### Added

- Comprehensive test coverage for AI hooks and components
- README documentation with usage examples
- `ChatEmptyState` component for empty chat screens
- `QuickReplyBar` component for quick reply suggestions
- `StreamingText` component with cursor animation
- Message adapter for Gifted Chat integration

### Changed

- Improved XState machine reliability
- Better error handling in chat flows
- Enhanced TypeScript type exports

### Fixed

- TypeScript configuration for cleaner builds
- Type checking with external dependencies

## [0.1.1] - 2025-12-15

### Fixed

- Minor bug fixes in chat machine
- Improved streaming text rendering

## [0.1.0] - 2025-11-01

### Added

- Initial release of `@mongrov/ai`
- **AI Client**:
  - `createAIClient` factory function
  - AI SDK integration
  - Streaming support
- **React Hooks**:
  - `useAIChat` for chat conversations
  - `useAICompletion` for single completions
- **XState Machines**:
  - Chat state machine with streaming support
  - Completion state machine
- **React Context**:
  - `AIProvider` for configuration
  - `useAIClient` and `useAIConfig` hooks
