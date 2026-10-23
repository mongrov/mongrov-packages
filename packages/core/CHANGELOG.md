# Changelog

All notable changes to `@mongrov/core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] - 2026-10-22

### Added
- **`LoggingProvider` accepts `logger`** (mongrov-packages#66): pass an app-created logger so React
  and non-React code share one instance. The provider never destroys a logger it was given.

### Changed
- **`captureException` keeps the error's own fields** (`code`, `status`, …) and its `cause`;
  context can no longer overwrite `stack` or `name`.
- **A throwing custom transport is contained**; it no longer throws into the code that logged.
- **An unknown `minLevel` and a failed background flush are logged** (warn), so they show in release.

## [0.7.0] - 2026-10-22

### Changed
- **File log is crash-safe.** On expo-file-system 19+ (`File` / `Paths` present) every batch is a
  true append: open, seek to the end, write, close. The file is never read to be written, so a kill
  or crash mid-write can cut at most the last line instead of losing the day. Older
  expo-file-system falls back to the previous read + rewrite and reports that once at info.
- **Hourly files with size rotation.** `logs-YYYY-MM-DDTHH-NNN.txt`, a new file every UTC hour and a
  new `NNN` past `FileConfig.maxFileSizeKB` (new, default 1024). A relaunch continues the hour's
  newest file. Pre-0.7 `logs-YYYY-MM-DD.txt` day files are still read (they sort before the same
  day's hourly files) and cleaned up.
- **Cleanup deletes whole files only** (retention, then oldest first under `maxSizeMB`) and never
  touches the file being written. The "cut today's file to its newest half" path is gone.
- **`LoggingProvider` flushes on background/inactive** (`AppState`), so batched lines reach disk
  before iOS suspends or kills the app.
- **Redaction on by default** (mongrov-packages#63): `LoggerConfig.redact` masks secret-looking keys
  and email-shaped text before any transport sees an entry; `false` logs verbatim. A throwing hook
  falls back to the default rules.
- **Entry caps** (#63): strings 2000 chars (stacks 8000), arrays 50 items, message 2000.

## [0.4.1] - 2026-04-23

### Fixed
- **Type Safety**: Added explicit `<void>` return types to `offline-queue` Promises to resolve strict TypeScript 5.9 compilation errors.

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
