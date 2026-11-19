# Upgrading @mongrov/auth

## 0.11 → 0.12

Additive; nothing to change unless you adopt the new pieces.

### Moving an app-owned secure-credentials module onto `createSecureCredentials`

1. Keep the **same key strings**. They are the keychain/keystore entry names; the package
   adds no prefix and no `keychainService`, so existing entries stay readable and signed-in
   users stay signed in.
2. Keep the **same `keychainAccessible`**. The default is `AFTER_FIRST_UNLOCK`; pass yours
   explicitly if it differs.
3. Move your key union into `keys: [...] as const` and derive the type with
   `CredentialKeyOf<typeof credentials>`.
4. If you migrated off a plaintext store, pass it as `legacy: { store, keys }` with the same
   legacy spellings; the store needs `getString(key)` and `delete(key)`.
5. Log lines are now `[secure-credentials] ... legacy store` (was app wording) and carry
   `error` as a string (`describeError`), key names only.

A test worth keeping in the app: write with the previous module, read with the new one
(and the reverse), for every key.

### Moving an app-owned Rocket.Chat auth adapter

Replace the adapter with `createRocketChatSessionAdapter({ port, logger })`, wiring the
port to your chat client and its store (`getCredentials`, `clearCredentials`,
`setUsername`, `fetchMe`, `revoke`). Error messages now start with
`rocketChatSessionAdapter.` instead of the app's prefix. Keep `proactiveRefresh: false`.

`createRocketChatClient` and `getOdooSession` from the old example adapters were not
moved: the first is a chat API client, not auth, and the second was a stub returning null.
