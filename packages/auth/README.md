# @mongrov/auth

Auth lifecycle, token management, and biometric gate for React Native / Expo apps.

## Features

- **Adapter pattern** — plug any backend by implementing `AuthAdapter`
- **Secure token storage** — expo-secure-store with MMKV fallback
- **Proactive token refresh** — timer-based refresh before expiry
- **401 interceptor** — Axios interceptor with single-flight refresh and request queueing
- **Biometric gate** — optional biometric authentication via expo-local-authentication
- **Social auth hooks** — Apple Sign In, Google Sign In with native OAuth
- **React context** — `AuthProvider`, `useAuth()`, `useSession()` hooks
- **Zustand state machine** — `idle → authenticating → authenticated → error`

## Install

```bash
pnpm add @mongrov/auth
# Peer deps
pnpm add zustand
# Optional
pnpm add expo-secure-store react-native-mmkv expo-local-authentication axios
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

Axios interceptor that attaches Bearer token and handles 401 refresh with single-flight deduplication. Returns an eject function.

Imported from a separate subpath to avoid leaking `axios` types into the main entry:

```ts
import { createAuthInterceptor } from '@mongrov/auth/interceptor';
```

### `useBiometricGate()`

Returns `{ isAvailable, isAuthenticated, authenticate, error }`. Falls back gracefully when expo-local-authentication is unavailable.

### Social Auth Hooks

Native social authentication hooks for Apple and Google sign-in.

#### `useAppleAuth()`

Apple Sign In for iOS using expo-apple-authentication.

```tsx
import { useAppleAuth } from '@mongrov/auth';

function AppleButton() {
  const { signIn, loading, error, isAvailable } = useAppleAuth();

  if (!isAvailable) return null; // Only available on iOS

  const handlePress = async () => {
    const result = await signIn();
    if (result) {
      // Pass result.identityToken to your backend
      await authClient.signIn({ provider: 'apple', token: result.identityToken });
    }
  };

  return <Button onPress={handlePress} loading={loading} title="Sign in with Apple" />;
}
```

#### `useGoogleAuth(config)`

Google Sign In using `@react-native-google-signin/google-signin` (v16+). Requires a native rebuild — does **not** work in Expo Go (use a dev client).

```tsx
import { useGoogleAuth } from '@mongrov/auth';

function GoogleButton() {
  const { signIn, loading, error } = useGoogleAuth({
    iosClientId: 'xxx.apps.googleusercontent.com',
    webClientId: 'zzz.apps.googleusercontent.com',
  });

  const handlePress = async () => {
    const result = await signIn();
    if (result) {
      // Pass result.idToken to your backend
      await authClient.signIn({ provider: 'google', token: result.idToken });
    }
  };

  return <Button onPress={handlePress} loading={loading} title="Sign in with Google" />;
}
```

On Android, the client ID is auto-detected from `google-services.json`; pass `webClientId` (and `iosClientId` on iOS). The returned `accessToken` may be `null` if the token fetch fails after a successful sign-in.

#### `useSocialAuth(config)`

Combined hook for all social providers.

```tsx
import { useSocialAuth } from '@mongrov/auth';

const { apple, google, signInWith, loading } = useSocialAuth({
  google: { webClientId: 'xxx.apps.googleusercontent.com' },
});

// Use specific provider hooks
await apple.signIn();
await google.signIn();

// Or use generic signInWith
const result = await signInWith('apple');
```

## License

MIT
