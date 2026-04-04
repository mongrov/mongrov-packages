# Changelog

All notable changes to `@mongrov/core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-04-03

### Added

- Improved test coverage for core logging functionality
- Additional log level configurations
- Better TypeScript type definitions

### Changed

- Enhanced logger performance for high-frequency logging
- Improved documentation and examples

## [0.3.0] - 2025-12-01

### Added

- `UIHookPanel` component for debugging hooks in development
- `useLoggerConfig` hook for runtime logger configuration
- Child logger support with `logger.child()`

### Changed

- Logger now supports structured metadata
- Improved console transport formatting

## [0.2.0] - 2025-10-15

### Added

- Remote transport for sending logs to external services
- Log batching and retry logic
- `onError` callback for transport failures

## [0.1.0] - 2025-08-01

### Added

- Initial release of `@mongrov/core`
- **Logging Framework**:
  - `createLogger` factory function
  - Log levels: error, warn, info, debug, trace
  - Console transport with formatting
  - React Native integration
- **React Hooks**:
  - `useLogger` hook for component-level logging
