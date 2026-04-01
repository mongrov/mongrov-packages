# @mongrov/auth

Auth lifecycle, token management, and biometric gate for React Native / Expo apps.

## Features

- **Adapter pattern** — plug any backend by implementing `AuthAdapter`
- **Secure token storage** — expo-secure-store with MMKV fallback
- **Proactive token refresh** — timer-based refresh before expiry
- **401 interceptor** — Axios interceptor with single-flight refresh and request queueing
- **Biometric gate** — optional biometric authentication via expo-local-authentication
- **React context** — `AuthProvider`, `useAuth()`, `useSession()` hooks
- **Zustand state machine** — `idle → authenticating → authenticated → error`

## Install

```bash
pnpm add @mongrov/auth
# Peer deps
pnpm add zustand react-native-mmkv @mongrov/core
# Optional
pnpm add expo-secure-store expo-local-authentication axios
```

## Quick Start

```tsx
import { AuthProvider, useAuth } from '@mongrov/auth';
import type { AuthAdapter, AuthClientConfig } from '@mongrov/auth';

const adapter: AuthAdapter = {
  login: async (creds) => { /* call your backend */ },
  refresh: async (refreshToken) => { /* refresh tokens */ },
  logout: async (accessToken) => { /* server-side logout */ },
};

const config: AuthClientConfig = {
  adapter,
  proactiveRefresh: true,
  refreshThreshold: 0.8,
};

function App() {
  return (
    <AuthProvider config={config}>
      <MyApp />
    </AuthProvider>
  );
}

function MyApp() {
  const { status, user, signIn, signOut } = useAuth();

  if (status === 'authenticated') {
    return <Button onPress={signOut} title={`Sign out ${user?.name}`} />;
  }
  return <Button onPress={() => signIn({ email: '...', password: '...' })} title="Sign in" />;
}
```

## API

### `createAuthClient(config: AuthClientConfig): AuthClient`

Low-level factory. Use `AuthProvider` for React apps.

### `AuthProvider`

React context provider. Creates an auth client, calls `hydrate()` on mount, and provides state via `useAuth()`.

### `useAuth()`

Returns `AuthState & { signIn, signOut }`. Throws if used outside `AuthProvider`.

### `useSession(): Session | null`

Derived session with `user`, `permissions`, `hasPermission()`, and `accessToken`. Returns `null` when not authenticated.

### `SecureTokenStore`

Secure token persistence. Uses `expo-secure-store` when available, falls back to `react-native-mmkv`.

### `createAuthInterceptor(axiosInstance, authClient): () => void`

Axios interceptor that attaches Bearer token and handles 401 refresh with request queueing. Returns an eject function.

### `useBiometricGate()`

Returns `{ isAvailable, isAuthenticated, authenticate, error }`. Falls back gracefully when expo-local-authentication is unavailable.

## License

MIT
