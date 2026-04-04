# @mongrov/db

Database utilities for `@mongrov` apps:

- **KVStore** — Unified async key-value storage (MMKV + SecureStore)
- **RxDB** — Document database with reactive queries and offline-first support

## Installation

```bash
pnpm add @mongrov/db react-native-mmkv

# For secure storage (optional)
npx expo install expo-secure-store

# For RxDB document database (optional)
pnpm add rxdb rxdb-premium
```

## KVStore

Unified async API over MMKV (fast) and SecureStore (secure).

### Basic Usage

```typescript
import { createKVStore } from '@mongrov/db'

// Default MMKV store for preferences
const prefs = createKVStore()
await prefs.set('theme', 'dark')
const theme = await prefs.get('theme') // 'dark'

// Store objects (JSON serialized)
await prefs.setObject('user', { id: 1, name: 'Alice' })
const user = await prefs.getObject<User>('user')
```

### Secure Storage

Use for tokens, secrets, and sensitive data:

```typescript
const tokens = createKVStore({ secure: true })
await tokens.set('accessToken', 'jwt...')
await tokens.set('refreshToken', 'refresh...')
```

### Instance Isolation

Create isolated stores with custom instance IDs:

```typescript
const cache = createKVStore({ instanceId: 'api-cache' })
const settings = createKVStore({ instanceId: 'user-settings' })

// These don't interfere with each other
await cache.set('data', 'cached')
await settings.set('data', 'settings')
```

### API

```typescript
interface KVStore {
  // String operations
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>

  // Object operations (JSON serialization)
  getObject<T>(key: string): Promise<T | null>
  setObject<T>(key: string, value: T): Promise<void>

  // Utility
  clear(): Promise<void>
  getAllKeys(): Promise<string[]>
}

interface KVStoreConfig {
  secure?: boolean    // Use SecureStore (default: false)
  instanceId?: string // MMKV instance ID (default: 'mongrov-kv')
}
```

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `secure` | `false` | Use expo-secure-store instead of MMKV |
| `instanceId` | `'mongrov-kv'` | MMKV instance ID for isolation (ignored when secure=true) |

## When to Use Each Backend

| Backend | Use For | Characteristics |
|---------|---------|-----------------|
| **MMKV** (default) | Preferences, theme, caches, flags | Fast, synchronous, large capacity |
| **SecureStore** | Tokens, secrets, credentials | Encrypted, platform keychain, 2KB limit per value |

## Auth Integration

Use `createTokenStore` to integrate with `@mongrov/auth`:

```typescript
import { createKVStore, createTokenStore } from '@mongrov/db'
import { createAuthClient } from '@mongrov/auth'

// Create secure KVStore for tokens
const secureStore = createKVStore({ secure: true })

// Bridge to auth's TokenStore interface
const tokenStore = createTokenStore(secureStore)

// Use with auth client
const authClient = createAuthClient({
  adapter: myAdapter,
  tokenStore, // Tokens now stored via KVStore
})
```

The `createTokenStore` function wraps a `KVStore` to implement auth's `TokenStore` interface:

```typescript
interface TokenStore {
  getAccessToken(): Promise<string | null>
  setAccessToken(token: string): Promise<void>
  getRefreshToken(): Promise<string | null>
  setRefreshToken(token: string): Promise<void>
  clear(): Promise<void>
}
```

## RxDB Database

Create offline-first document databases with reactive queries.

### Creating a Database

```typescript
import { createDatabase } from '@mongrov/db'
import { getRxStorageSQLite } from 'rxdb-premium/plugins/storage-sqlite'

// Define your schema
const messageSchema = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 100 },
    content: { type: 'string' },
    conversationId: { type: 'string' },
    createdAt: { type: 'number' },
  },
  required: ['id', 'content', 'conversationId'],
  indexes: ['conversationId', 'createdAt'],
}

// Create the database
const db = await createDatabase({
  name: 'myapp',
  storage: getRxStorageSQLite(),
  collections: [
    { name: 'messages', schema: messageSchema },
    { name: 'conversations', schema: conversationSchema },
  ],
  logger: console, // Optional: log database operations
})
```

### React Integration

Use the `DatabaseProvider` and hooks for reactive data access:

```tsx
import {
  DatabaseProvider,
  useDatabase,
  useCollection,
  useQuery,
  useDocument,
} from '@mongrov/db'

// Wrap your app with the provider
function App() {
  const [db, setDb] = useState(null)

  useEffect(() => {
    createDatabase(config).then(setDb)
    return () => db?.destroy()
  }, [])

  return (
    <DatabaseProvider database={db}>
      <MyApp />
    </DatabaseProvider>
  )
}

// Access database and collections
function MessageList({ conversationId }) {
  const { db, isReady } = useDatabase()
  const messages = useCollection('messages')

  // Reactive query with automatic updates
  const { data, isLoading, error } = useQuery('messages', {
    selector: { conversationId },
    sort: [{ createdAt: 'desc' }],
    limit: 50,
  })

  if (isLoading) return <Loading />
  if (error) return <Error message={error.message} />

  return <FlatList data={data} renderItem={renderMessage} />
}

// Fetch single document by ID
function MessageDetail({ messageId }) {
  const { data: message, isLoading } = useDocument('messages', messageId)

  if (isLoading) return <Loading />
  if (!message) return <NotFound />

  return <MessageView message={message} />
}
```

### Schema Migrations

Handle schema upgrades with migration strategies:

```typescript
const collections = [
  {
    name: 'messages',
    schema: messageSchemaV2, // version: 2
    migrationStrategies: {
      1: (oldDoc) => ({ ...oldDoc, readStatus: 'unread' }),
      2: (oldDoc) => ({ ...oldDoc, reactions: [] }),
    },
  },
]
```

### API Reference

```typescript
// Database factory
createDatabase(config: DatabaseConfig): Promise<RxDatabase>
destroyDatabase(db: RxDatabase): Promise<void>

// React hooks
useDatabase(): { db: RxDatabase | null, isReady: boolean }
useCollection<T>(name: string): RxCollection<T> | null
useQuery<T>(collection: string, query?: MangoQuery): QueryResult<T>
useDocument<T>(collection: string, id: string | null): DocumentResult<T>

// Result types
interface QueryResult<T> {
  data: T[]
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

interface DocumentResult<T> {
  data: T | null
  isLoading: boolean
  error: Error | null
  refetch: () => void
}
```

### Replication

Sync collections with remote backends using push/pull handlers:

```typescript
import { createReplicationState, cancelReplication } from '@mongrov/db'

// Create replication with push/pull handlers
const replication = createReplicationState({
  replicationIdentifier: 'messages-sync',
  collection: db.messages,

  // Push local changes to remote
  push: {
    handler: async (docs) => {
      await api.sendMessages(docs)
    },
    batchSize: 50,
  },

  // Pull remote changes
  pull: {
    handler: async (checkpoint, batchSize) => {
      const result = await api.getMessages({ since: checkpoint, limit: batchSize })
      return {
        documents: result.messages,
        checkpoint: result.lastTimestamp,
      }
    },
    batchSize: 100,
  },

  live: true, // Enable real-time sync
  logger: console,
})

// Listen for errors
replication.error$.subscribe((error) => {
  console.error('Sync error:', error)
})

// Trigger manual sync
await replication.reSync()

// Stop replication when done
await cancelReplication(replication)
```

The replication helper is a thin wrapper over RxDB's replication plugin. Your push/pull handlers connect to your backend (REST API, WebSocket, or @mongrov/collab adapter).

## Peer Dependencies

- `react-native-mmkv` (required for KVStore)
- `expo-secure-store` (optional — only if using `secure: true`)
- `rxdb` (optional — only if using database features)

## License

MIT
