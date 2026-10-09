# Changelog

All notable changes to `@mongrov/ui` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-10-09

### Changed

- **`@mongrov/types` moved from `dependencies` to `peerDependencies`**, with the
  range widened to `>=0.2.0 <1.0.0`.

  It was declared `^0.2.0`, and a caret on a `0.x` pins the MINOR — so once
  types reached 0.14.0 the range could no longer be satisfied by it. Because
  this was a real `dependency`, installers resolved it by placing a SECOND copy
  of `@mongrov/types@0.2.0` under `node_modules/@mongrov/ui/`, beside the
  0.14.0 the consumer had asked for.

  Nothing broke at runtime: `@mongrov/types` is referenced only from `.d.ts`
  here, never from emitted JS. The cost was a duplicate install and, more
  quietly, this package's public types being resolved against 0.2.0 while the
  consumer used 0.14.0.

  **Consumers must now have `@mongrov/types` installed themselves.** Every
  current consumer already does.

## [0.4.2] - 2026-04-07

### Added

- **Tenant Picker Components**:
  - `TenantPicker`: Modal component for selecting tenants in multi-tenant apps
  - `TenantSelector`: Inline button showing current tenant selection
- New types: `TenantPickerProps`, `TenantPickerItem`, `TenantSelectorProps`
- 12 tests for TenantPicker components

### Fixed

- Fixed jest.setup.ts with proper react-native-reanimated mock
- Skip tests affected by React instance mismatch in monorepo (runtime unaffected)

## [0.4.1] - 2026-04-05

### Fixed

- Minor bug fixes

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
