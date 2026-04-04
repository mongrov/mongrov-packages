# Troubleshooting Guide

Common issues and solutions when working with `@mongrov` packages.

## Table of Contents

- [General Issues](#general-issues)
- [@mongrov/collab](#mongrovcollab)
- [@mongrov/db](#mongrovdb)
- [@mongrov/ui](#mongrovui)
- [@mongrov/auth](#mongrovauth)

---

## General Issues

### TypeScript Errors with RxDB Types

**Problem**: TypeScript errors when using RxDB collections or documents.

**Solution**: The `@mongrov/db` package uses type aliases (`RxDatabaseType`, `RxCollectionType`, etc.) to avoid compile-time dependency on RxDB types. When you need strict typing, import types directly from `rxdb`:

```typescript
import type { RxCollection, RxDocument } from 'rxdb'
import type { MessageDocType } from './schemas'

const messages: RxCollection<MessageDocType> = db.messages
```

### pnpm Workspace Issues

**Problem**: Package not found or version mismatch errors.

**Solution**:
1. Run `pnpm install` from the monorepo root
2. Check that `workspace:*` is used in package.json for internal dependencies
3. Run `pnpm build` to ensure all packages are built

---

## @mongrov/collab

### "useCollab must be used within a CollabProvider"

**Problem**: Error when using `useCollab`, `useMessages`, `useTyping`, or `usePresence` hooks.

**Solution**: Wrap your component tree with `CollabProvider`:

```tsx
import { CollabProvider } from '@mongrov/collab'

function App() {
  const adapter = useMemo(() => new MyAdapter(), [])

  return (
    <CollabProvider config={{ adapter }}>
      <YourApp />
    </CollabProvider>
  )
}
```

### Connection State Machine Not Transitioning

**Problem**: Connection stays stuck in "connecting" or "reconnecting" state.

**Checklist**:
1. Ensure your adapter's `connect()` method calls `this.setStatus('connected')` on success
2. Ensure your adapter emits `connection:connected` event on successful connection
3. Check if `connect()` is throwing an error (check console)
4. Verify credentials are valid

```typescript
// In your adapter implementation:
async connect(credentials: AdapterCredentials) {
  try {
    await this.client.connect(credentials)
    this.setStatus('connected')  // Required!
    this.emit('connection:connected', undefined)  // Required!
  } catch (error) {
    this.setStatus('error')
    this.emit('connection:error', { error })
    throw error
  }
}
```

### Messages Not Updating in Real-Time

**Problem**: New messages not appearing automatically.

**Checklist**:
1. Ensure `subscribeToConversation()` returns a valid unsubscribe function
2. Ensure your adapter emits `message:received` when new messages arrive
3. Check that `conversationId` matches between hook and event payload

```typescript
// Emit message event in your adapter when receiving from backend:
this.emit('message:received', {
  id: 'msg-1',
  conversationId: 'conv-1',  // Must match the conversationId in useMessages()
  sender: { id: 'user-1', name: 'User', type: 'human' },
  content: { type: 'text', text: 'Hello' },
  deliveryStatus: 'sent',
  createdAt: new Date().toISOString(),
})
```

### Typing Indicators Not Working

**Problem**: Typing indicators not appearing or disappearing.

**Solution**: Ensure your adapter emits the correct events:

```typescript
// When someone starts typing:
this.emit('typing:start', {
  conversationId: 'conv-1',
  userId: 'user-1',
  userName: 'Alice'
})

// When someone stops typing:
this.emit('typing:stop', {
  conversationId: 'conv-1',
  userId: 'user-1'
})
```

Note: The `useTyping` hook automatically removes users after 5 seconds of no updates.

---

## @mongrov/db

### "useDatabase must be used within a DatabaseProvider"

**Problem**: Error when using `useDatabase`, `useCollection`, or `useQuery` hooks.

**Solution**: Wrap your component tree with `DatabaseProvider`:

```tsx
import { DatabaseProvider, createDatabase } from '@mongrov/db'

function App() {
  const [db, setDb] = useState(null)

  useEffect(() => {
    createDatabase(config).then(setDb)
  }, [])

  return (
    <DatabaseProvider database={db}>
      <YourApp />
    </DatabaseProvider>
  )
}
```

### Database Creation Fails on Hot Reload

**Problem**: Error "Database already exists" during development.

**Solution**: Enable `ignoreDuplicate` in your config (default is `true`):

```typescript
const config: DatabaseConfig = {
  name: 'mydb',
  storage: getRxStorageSQLite(),
  collections: [...],
  ignoreDuplicate: true,  // Ignore during hot reload
}
```

### Queries Not Updating

**Problem**: `useQuery` results not reflecting document changes.

**Checklist**:
1. Ensure the collection name is correct
2. Check that the query selector matches the documents
3. Verify documents are being saved correctly

```typescript
// Debug: log all documents in collection
const { data } = useQuery('messages', {})
console.log('All messages:', data)
```

### KVStore Not Persisting

**Problem**: Values disappear after app restart.

**Checklist**:
1. For MMKV: Ensure `react-native-mmkv` is properly linked
2. For SecureStore: Ensure `expo-secure-store` is installed
3. Check that `await` is used on all KVStore methods

```typescript
// Correct usage:
await kvStore.set('key', 'value')
const value = await kvStore.get('key')

// Incorrect (not awaiting):
kvStore.set('key', 'value')  // May not persist!
```

---

## @mongrov/ui

### NativeWind/Tailwind Styles Not Applying

**Problem**: Tailwind classes not working on components.

**Solution**:
1. Ensure NativeWind is properly configured in your app
2. Add `@mongrov/ui` to your Tailwind content paths:

```js
// tailwind.config.js
module.exports = {
  content: [
    './src/**/*.{js,jsx,ts,tsx}',
    './node_modules/@mongrov/ui/**/*.{js,jsx,ts,tsx}',
  ],
  // ...
}
```

### Headless Components Not Rendering

**Problem**: `MessageRenderer`, `AttachmentRenderer`, or `ReactionPicker` not showing anything.

**Solution**: These are headless components - you must provide render props:

```tsx
const { getRootProps, items } = useMessageRenderer({ messages })

return (
  <View {...getRootProps()}>
    {items.map(item => (
      <View key={item.id}>
        <Text>{item.content}</Text>
      </View>
    ))}
  </View>
)
```

---

## @mongrov/auth

### Token Not Persisting

**Problem**: User logged out after app restart.

**Checklist**:
1. Ensure secure storage is properly configured
2. Check that tokens are being stored after login
3. Verify `onTokenRefresh` callback is implemented

### Biometric Authentication Failing

**Problem**: Biometric prompt not showing or failing.

**Checklist**:
1. Check device has biometric hardware enrolled
2. Ensure proper permissions in app.json/AndroidManifest
3. For iOS: Check if FaceID/TouchID is enabled in device settings

---

## Getting Help

If your issue isn't covered here:

1. Check the README for each package
2. Review the JSDoc comments in the source code
3. Open an issue at https://github.com/mongrov/mongrov-packages/issues

When reporting issues, please include:
- Package name and version
- Node.js and pnpm versions
- Relevant error messages and stack traces
- Minimal reproduction code
