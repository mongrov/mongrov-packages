# Changelog

All notable changes to `@mongrov/auth` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.1] - 2026-04-30

### Fixed
- **`scopes` config now honored**: `GoogleAuthConfig.scopes` is passed through to `GoogleSignin.configure()`. This restores parity with 0.5.2, where custom scopes were respected (regression introduced in 0.6.0).
- **Resilient access token fetch**: `GoogleSignin.getTokens()` failures no longer fail the entire sign-in. The user is signed in to the SDK regardless; the hook returns `accessToken: null` and the caller can refetch later.

### Deprecated
- `GoogleAuthConfig.androidClientId` is now marked `@deprecated`. It has had no effect since 0.6.0 (Android client ID is auto-detected from `google-services.json`). Will be removed in a future major release.

### Internal
- Test indentation cleanup in `auth-provider.test.tsx`.

## [0.6.0] - 2026-04-23

### BREAKING CHANGES

- **Google Sign-In backend swapped from `expo-auth-session` to `@react-native-google-signin/google-signin` (v16+).** This is a native module — **does not work in Expo Go**; consumers must use a dev client and rebuild the app.
- **Peer dependencies changed**:
  - Removed: `expo-auth-session`, `expo-web-browser`
  - Added: `@react-native-google-signin/google-signin >=16` (optional)
- **`GoogleAuthResult.accessToken` type changed** from `string` to `string | null`. The token is fetched separately after sign-in and may be `null` if that fetch fails.

#### Migration

```diff
- pnpm remove expo-auth-session expo-web-browser
+ pnpm add @react-native-google-signin/google-signin
```

Then rebuild the native app (or `eas build`). The hook API is unchanged for the common case:

```tsx
const { signIn } = useGoogleAuth({
  iosClientId: '...',
  webClientId: '...',
});
```

If you read `result.accessToken`, narrow for `null`:

```ts
if (result?.accessToken) { /* ... */ }
```

### Added
- **Native Google Sign-in**: Integrated `@react-native-google-signin/google-signin` for a robust, native authentication experience.
- **Unit Tests**: Added comprehensive test coverage for native authentication logic and hooks.

### Fixed
- **Test Environment Stability**: Resolved "Uncaught Exception" errors in Jest by properly mocking native modules and silencing intentional render errors during hook testing.
- **Import Resolution**: Fixed relative path mapping in social authentication test files.

## [0.5.2] - 2026-04-07

### Added

- **Social Authentication Hooks**:
  - `useAppleAuth()`: Apple Sign In for iOS using expo-apple-authentication
  - `useGoogleAuth()`: Google Sign In using expo-auth-session
  - `useSocialAuth()`: Combined hook for all social providers
- New types: `AppleAuthResult`, `GoogleAuthResult`, `SocialAuthResult`, `SocialAuthError`
- Optional peer dependencies for social auth: expo-apple-authentication, expo-auth-session, expo-web-browser
- 15 new tests for social auth hooks

### Changed

- Updated peer dependencies to include social auth packages as optional

## [0.5.1] - 2026-04-05

### Fixed

- Minor bug fixes and improvements

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
