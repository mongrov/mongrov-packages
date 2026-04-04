# Changelog

All notable changes to `@mongrov/auth` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-04-03

### Added

- Comprehensive test suite for auth flows
- Additional biometric authentication options
- Improved error handling and recovery

### Changed

- Enhanced token refresh reliability
- Better TypeScript type exports
- Improved documentation

## [0.4.0] - 2026-01-15

### Added

- `SecureTokenStore` for encrypted token storage
- Biometric authentication support
- Session management utilities

### Changed

- Improved interceptor error handling
- Better token expiration detection

## [0.3.0] - 2025-11-01

### Added

- `AuthProvider` React context
- `useAuth` hook for authentication state
- HTTP interceptor for automatic token injection

## [0.2.0] - 2025-09-15

### Added

- Token refresh manager with automatic renewal
- JWT decoding utilities
- Session state tracking

## [0.1.0] - 2025-07-01

### Added

- Initial release of `@mongrov/auth`
- **Auth Client**:
  - Login/logout flows
  - Token storage interface
  - XState-powered auth machine
- **React Hooks**:
  - `useAuth` for auth state management
