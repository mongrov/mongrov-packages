# Changelog

All notable changes to `@mongrov/db` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-03

### Added

- Comprehensive test coverage (78 tests)
- Integration tests for replication flows
- Improved error handling in KVStore operations
- Better TypeScript type exports

### Changed

- Enhanced replication state management
- Improved hook performance with memoization
- Better documentation and examples

### Fixed

- Memory leak in query subscriptions
- Edge cases in SecureStore operations

## [0.1.0] - 2024-01-15

### Added

- Initial release of `@mongrov/db`
- **KVStore**: Unified async key-value store interface
  - `createKVStore()`: Factory for creating KV stores
  - MMKV adapter for fast local storage
  - SecureStore adapter for sensitive data (tokens, secrets)
  - Support for JSON serialization via `getObject`/`setObject`
- **RxDB Integration**:
  - `createDatabase()`: Factory for creating RxDB database instances
  - React hooks for database access:
    - `DatabaseProvider`: Context provider
    - `useDatabase()`: Access database instance
    - `useCollection()`: Access a collection by name
    - `useQuery()`: Reactive queries with auto-updates
    - `useDocument()`: Reactive document access
- **Replication**:
  - `createReplicationState()`: Factory for RxDB replication with custom push/pull handlers
  - `cancelReplication()`: Clean up replication state
  - `resyncReplication()`: Trigger manual sync
- **TypeScript**: Full type definitions for all public APIs

### Dependencies

- `rxdb` ^15.0.0 (peer dependency)
- `react-native-mmkv` (peer dependency)
- `expo-secure-store` (peer dependency)
