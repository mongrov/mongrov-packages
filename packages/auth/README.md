# @mongrov/auth

Auth lifecycle, token management, and biometric gate for React Native / Expo apps.

## Features

- **Adapter pattern** — plug any backend by implementing `AuthAdapter`
- **Secure token storage** — expo-secure-store, no plaintext fallback
- **Secure credentials** — sync keychain storage with an app-extensible key union and plaintext migration
- **Backend adapters** — Rocket.Chat (session handoff or password/OAuth) and Odoo
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

Secure token persistence in `expo-secure-store` (keychain / keystore). Without it, saving a token rejects: tokens are never written to plain storage.

### `createSecureCredentials({ keys, legacy?, keychainAccessible?, logger? })`

Synchronous credential storage on the keychain / keystore (`expo-secure-store` `getItem` / `setItem`), for every credential the app keeps — the auth client's tokens and any other service's token — so they cannot drift apart across two backends.

The key type is **app-supplied**: pass the keys `as const` and the union is inferred. A key outside it is a `tsc` error, and every key is checked against `SECURE_STORE_KEY_PATTERN` (`/^[\w.-]+$/`, which expo-secure-store enforces by throwing) when the store is created.

```ts
import type { CredentialKeyOf } from '@mongrov/auth';
import { createSecureCredentials } from '@mongrov/auth';

export const credentials = createSecureCredentials({
  keys: ['mongrov.auth-access', 'mongrov.auth-refresh', 'chat.authToken'] as const,
  // Optional one-way move off a plaintext store: copied on first read, then deleted there.
  legacy: { store: plainKv, keys: { 'chat.authToken': 'chat:authToken' } },
  logger,
});
export type CredentialKey = CredentialKeyOf<typeof credentials>;

credentials.write('chat.authToken', token); // throws on failure
credentials.read('chat.authToken');         // string | null, never throws
credentials.delete('chat.authToken');       // nothing readable on return
```

- Keys are the on-device entry names, used as given (no prefix, no keychain service). Renaming one signs existing users out of it.
- `keychainAccessible` defaults to `AFTER_FIRST_UNLOCK` (readable by background work while locked; kept on backup restore). Keep it stable across releases.
- The logger receives key names and failure reasons only, never values.

### Backend adapters

Ready-made `AuthAdapter`s. None takes an admin or service token: anything an app is built with is readable from its bundle, so privileged calls belong on a server. Options named like one (`adminToken`, `serviceToken`, ...) are refused.

**`createRocketChatSessionAdapter({ port, logger?, revokeTimeoutMs?, tokenLifetimeSeconds?, httpStatusOf? })`** — for an app whose Rocket.Chat client performs the login and keeps the user's token. The app passes `signIn({ authToken, userId })`; the adapter wraps the token in an unsigned JWT with `exp` (so hydrate's expiry check passes) and talks to the client only through a small port:

```ts
const adapter = createRocketChatSessionAdapter({
  port: {
    getCredentials: () => chatStore.getState(),            // { authToken, userId }
    clearCredentials: () => chatStore.getState().clearCredentials(),
    setUsername: name => chatStore.getState().setUsername(name),
    fetchMe: () => chatApi.get('/me'),
    revoke: (creds, signal) => chatApi.logout(creds, signal), // POST /logout with these creds
  },
  logger,
});
```

At sign-out it starts `revoke` with the captured token, clears the device without waiting, and gives up after `revokeTimeoutMs` (default `ROCKETCHAT_REVOKE_TIMEOUT_MS`, 3 s); the outcome is logged as `auth.logout.server_revoke` with a status, never the token. `getUser` never returns an empty id. Use `proactiveRefresh: false` with it (the token lifetime is a year).

**`createRocketChatAdapter({ baseUrl, timeout?, logger? })`** — email/password and native OAuth login against `/api/v1/login`; logout calls `/api/v1/logout`.

**`createOdooAdapter({ baseUrl, database, timeout?, logger? })`** — JSON-RPC session login (`/web/session/authenticate`), cookie session refresh, `/web/session/destroy` on logout.

The last two need the optional `axios` peer; it is loaded only when one of them is created.

### `redactAuthString(value)`

Log-safe form of free text: a token-shaped value becomes `[redacted]`, e-mail addresses become `[email]`.

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
