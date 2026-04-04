# Changelog

All notable changes to `@mongrov/ui` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-04-03

### Added

- Comprehensive test coverage (124 tests)
- README documentation with usage examples
- Improved accessibility labels for auth components

### Changed

- Enhanced component performance
- Better TypeScript type exports
- Improved dark mode support

### Fixed

- Type issues in CVA variants
- Accessibility improvements for buttons

## [0.3.0] - 2025-12-01

### Added

- **Shared Renderers** (headless components):
  - `MessageRenderer`: Headless message rendering with `useMessageRenderer` hook
  - `AttachmentRenderer`: Headless attachment rendering for images, files, audio, video
  - `ReactionPicker`: Headless emoji reaction picker with search and recent tracking
- **Status Components**:
  - `ConnectionIndicator`: Visual connection status display
  - `NetworkBanner`: Offline/online network status banner
  - `SyncIndicator`: Data synchronization progress indicator
  - `StatusBadge`: Generic status badge component
- **State Components**:
  - `LoadingState`: Loading spinner with optional message
  - `EmptyState`: Empty content placeholder with icon and action
  - `ErrorState`: Error display with retry option

### Changed

- Improved TypeScript types for Card component (removed `any` usage)

## [0.2.0] - 2025-10-15

### Added

- **Primitives**: Text, Button, Card, Separator, Skeleton
- **Auth Components**: AuthDivider, SSOButton, SocialLoginButton
- NativeWind/Tailwind CSS integration

## [0.1.0] - 2025-08-01

### Added

- Initial release with basic primitive components
